# RUN-05 handoff — Review queue, blocking gates, resume, scheduler, Dashboard

**Branch:** `run/05-review-scheduler` · **Head:** `a85e612` · **Status:** awaiting verification

## Built
- `src/runtime/db/migrations/0006_review_scheduler.sql` — `reviews`, `ratings`, `schedules`.
- `src/runtime/review/store.ts` — the quality queue. Every completed step opens a review row: `unreviewed` by default, `pending` when the step is a blocking gate. A re-run reopens the same row (attempt + 1) rather than adding a second, and reopening clears the feedback, because the step has just answered it.
- `src/runtime/engine/run.ts` — the gate: a blocking step sets the run to `waiting_review`, emits `review-requested`, and waits on a promise the human's decision resolves. `decideReview` releases a live waiter, or resumes the run when the waiter died with a restart. `resume()` restarts from the last finished step. `markInterrupted()` deliberately leaves `waiting_review` alone.
- `src/runtime/engine/workflow-run.ts` — `ReviewHost`, the reject-and-re-run loop (not one of `retries`: a human asking for something different is not a model failing), and `completed` preloading for resume.
- `src/runtime/engine/step.ts` — feedback is appended to the *task*, under a rule saying who wrote it, never merged into the system prompt; the step reports the document version it filed, so a review and a rating point at something.
- `src/runtime/scheduler/index.ts` — in-process, local time zone, `croner` for the cron arithmetic only. `seedFromWorkflows` seeds a row once per workflow file and never again. `tick()` is public so tests drive it with an injected clock.
- Routes: `GET /reviews`, `POST /reviews/:id`, `POST /ratings`, `GET/POST /schedules`, `DELETE /schedules/:id`, `POST /runs/:id/resume`, `GET /dashboard`.
- CLI: `review list|show|continue|reject|dismiss|rate`, `runs resume`, `schedules list|add|remove`.
- `src/ui/screens/Dashboard.tsx` — *Needs you*, *Running* with budget lines and Cancel, *Today* with spend against the cap and the next scheduled runs, and Pause all.
- `src/ui/screens/Review.tsx` — the queue, keyboard-first: `j`/`k` move, `1`–`5` rate, `c` continues a gate, `r` starts a rejection, `Esc` closes it.
- `src/ui/screens/Workflows.tsx` — a schedule editor with presets, pause/resume, and what happens to missed windows.
- `src/ui/components/RunGraph.tsx` — a blocking step is marked "waits for you", in the picture and in its text alternative.

## Not built (deliberate)
- Tools, memory, and the approvals mechanism — the brief's *Do not*. Approvals are RUN-06 and are a different table, a different event, and a different screen section.
- "Re-run downstream from an edited version" (`ui.md` lists it for RUN-05). Rejection re-runs the step that produced the version, which is the same need through the door the brief's DoD names. Re-running *downstream* of a human edit needs the edited version to become a step's input, and that is the Library's shape, not the review queue's. Left for RUN-08, where knowledge ingestion makes a document an input in its own right.
- A timeout on blocking gates: the brief says there is none by default, and there is none.

## Deviations from the brief
- **A blocking CLI run stops at the gate instead of waiting.** `workbench run workflow` without `--detach` starts an ephemeral runtime it owns; nothing can decide the gate while it waits, so waiting is an infinite loop with good manners. It prints the review id and the command that continues. Amended into `api-and-cli.md`.
- **Deciding a gate from the CLI requires a live runtime.** A second process deciding it would leave the first holding a waiter that never resolves, and would run the rest of the workflow twice against the same database. Amended.
- **`waiting_review` is not marked `interrupted` on startup**, and resuming a run held by an undecided gate is refused. The review row is durable state, not lost work; that run is waiting, not stuck. Amended into `workflows-and-execution.md`.
- **`review-requested` is a new event type.** Reusing `approval-requested` would have been convenient and wrong (D-13). Amended.
- **`runs.spent_json` is written after every model call.** The Dashboard's budget bar was showing zeros for a run in flight, which is worse than showing nothing.

## Verification transcript
```
$ npm run check
typecheck · lint · 53 unit · 35 security · 47 contract · secret-scan: clean — green
$ npm run dod -- 05
7 passed, then 2 e2e cases tagged @run-05 passed
$ npm run dod -- 00 / 01 / 02 / 03 / 04
6 / 7 / 8 / 7 / 6+1skipped passed, all tagged e2e passed
$ npm run e2e
19 passed, axe clean on every screen
```

## SEC tests added
- SEC-28b → `tests/security/sec-28b-daily-cap.test.ts`: a schedule fires with nobody watching, so the daily cap is the only thing between a bad loop and a month's budget. The first firing burns the cap; the second is refused *before its first model call* (`spent.modelCalls === 0`), fails with `daily_cap_reached`, and says so in words a human can act on.

## Bugs found by the tests
- **Resume skipped a rejected step.** The database still called it completed, so the human's feedback was written down and then ignored — the worst possible failure for this feature. `finishedSteps` now excludes rejected steps and the executor seeds the re-run with their feedback.
- The CLI printed "rejectd".

## Spec amendments made
- `spec/workflows-and-execution.md` — rejected steps and undecided gates on resume; `review-requested`; the scheduler's clock and how `catchUp: once` stays one run
- `spec/api-and-cli.md` — the review, rating, schedule, resume and dashboard surfaces; live `spent_json`; the two CLI rules above
- `spec/ui.md` — the graph marks a blocking gate

## For the next run (RUN-06: tools, permissions, approvals)
- The validator still refuses `kind: 'tool'` by name, with a message saying RUN-06. Change it there.
- The agent step loop already answers an unknown tool with `{ ok: false, error: { code: 'UnknownTool' } }` and keeps going; RUN-06 replaces the refusal with the broker and adds `PermissionDenied` beside it.
- `approvals` is the only table in `data-model.md` still unbuilt for the lifecycle. The gate machinery in `Engine.reviewHost()` is the shape an approval gate wants — a durable row, an in-memory waiter, and a decision that resumes a run whose waiter died — but it must stay a *separate* queue and a separate event (D-13).
- `context.keepRecentToolResults` and `context.maxToolResultChars` are in config and unused: D-47 belongs with the first real tool results.

## Still outstanding for the owner
No cloud adapter has yet spoken to its provider. `npm run contract -- --live google` verifies the adapters against the real APIs; `WB_LIVE=1 npm run dod -- 04` runs the story pipeline on Gemini. Both need a credential in the workspace or the environment.

## Human verification script
1. `npm run build && node dist/cli.js init ~/wb-05 && node dist/cli.js start --workspace ~/wb-05`.
2. Open **Dashboard**. Expect *Needs you*, *Running*, and *Today* with spend against the daily cap.
3. Run a workflow with a blocking gate. Expect the run to reach the gate and stop as `waiting_review`, the
   graph to mark that step "waits for you", and a card to appear under *Needs you*.
4. Open **Review**. Use only the keyboard: `j`/`k` to move, `1`–`5` to rate, `c` to continue, `r` to reject,
   `Esc` to close. Reject the step with a sentence of feedback.
5. Expect the step to re-run with your feedback in the *task*, not in the system prompt — open the trace and
   read the compiled prompt to confirm which section it landed in, and that it says who wrote it.
6. Confirm the same review row was reopened rather than duplicated: the queue should show one row for that step
   with an attempt count, not two rows.
7. Now the part that only a restart proves. With a run parked at a gate, press Ctrl-C in the runtime terminal
   and start it again. Expect that run still `waiting_review` — *not* marked interrupted — and expect deciding
   the review from the UI to resume it. A run that is waiting for you is not a run that crashed.
8. Open **Workflows → schedule**. Add a schedule with a preset, then pause it. Expect *Today* on the Dashboard
   to list the next runs, and **Pause all** to stop them without deleting anything.
9. `node dist/cli.js schedules list --workspace ~/wb-05` and `review list`. The terminal should tell you the
   same thing the screens do.
