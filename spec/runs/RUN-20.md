# RUN-20 — The villagers

*Draft, written with RUN-19. The owner may strike or reshape it before `run/20-villagers` exists.*

**Goal.** The agents live in the village. Each is a figure that stands where its work is — at the workshop while a workflow runs, at the town hall door when it needs you, at the records office when its run stopped, at the lodge when it is waiting for work — and the town hall's notice board says what finished while you were away. The owner's words: "If I've been away, the sprites representing each agent that has been running a task while I was gone."

**Reads.** D-62, D-71, `ui.md` (rule 12 and the RUN-19 amendment), `tools-and-security.md` §Approvals, `api-and-cli.md` (the workspace stream, `/dashboard`), `data-model.md` (the `settings` table), `src/shared/village.ts`, `runlog/RUN-19.md`.

**Scope.**
- **Since you last looked.** `GET /api/v1/away` → `{ since, now, runs }`: the runs that finished after `since`, newest first, at most a hundred; `since` null means the last day. `POST /api/v1/away/seen` sets it to now. `since` lives in the sqlite `settings` table (`0001_init.sql`), which exists and has never been used — no migration. `Engine.listRuns` gains `finishedSince`. `workbench away [--seen] [--json]` prints the same (ui.md: everything the UI shows, the CLI shows).
- **The dashboard tells the truth about approvals.** `dashboard.running` includes `waiting_approval`; today a run parked on a permission is in `approvals` and in neither `running` nor `failed`.
- **The stream says when something happens.** `GET /runs/events` carries, beside `run-*`, `step-started|completed|failed`, `approval-requested|decided` and `review-requested|decided` — and for those the frame is `{ seq, runId, stepId, type, ts }` only: ids and kinds, never arguments, never text (the SEC-32 shape). `useLiveRuns` moves into the Shell, one connection, invalidating `runs`, `dashboard`, `reviews` and `away`.
- **Where a figure stands** — `derivePresence(agents, runs, approvals, needsYou, since)` in `src/shared/village.ts`, pure and unit-tested, first match wins per agent: a run in `waiting_approval` → the town hall door, with the approval card in its popover; a blocking `waiting_review` → the town hall door, with a link to Review; `running` or `queued` → the Library if the run names a project, the workshop if it is a workflow, else the square, with the budget line and Cancel (ui.md §UX rules) and a link to the run; the last run `failed` or `interrupted` after `since` → the records office, flagged, with Resume; the last run `completed` after `since` → the notice board, with what it produced; otherwise → the lodge, "waiting for work", with *Run it*. A workflow run has no agent: it is a cart at the workshop with the same popover, until RUN-21 attributes its steps.
- **The figures.** A second list after the buildings, `aria-label="Villagers"`, each an HTML button with a visible name tag and an accessible name like "Weaver, working in Anthology", opening a non-modal card beside it; Esc closes it and returns focus; a screen-reader list says the same sentences (RunGraph's precedent). A figure's look is fixed by its agent id. It moves only when its derived place changes, with `motion-safe` alone.
- **The board.** The notice board on the square lists what finished since `since`, per agent, each a link, with *Clear the board*.

**Do not.**
- Do not let a figure wander, idle-walk or animate on a timer: it moves when a run's state moves it (D-71, ui.md rule 12).
- Do not put arguments, outputs, document text or tool results on the workspace stream: ids and kinds only (SEC-39).
- Do not let the figures come before Settings in the tab order, or the shell test's twenty-five presses break.
- Do not add a migration for one key.

**Definition of done** (`npm run dod -- 20`).
1. `/away` with nothing seen returns the last day's finished runs; after `/away/seen` a run finished before it is not listed and one finished after it is; the mark survives a runtime restart.
2. `dashboard.running` carries a run in `waiting_approval`.
3. On the workspace stream a `step-completed`, an `approval-requested` and a `review-requested` frame each carry exactly `seq, runId, stepId, type, ts`; `run-*` frames are unchanged.
4. `derivePresence`: one case per row of the table above, and an agent with no runs at all stands at the lodge.
5. `workbench away --json` equals `GET /away`; `--seen` marks.
6. e2e `@run-20`: a slow story-pipeline run puts a figure at the workshop whose popover shows the meter and Cancel; cancelling it moves the figure; axe clean with the popover open; the board lists a finished run and *Clear the board* empties it; under reduced motion a figure's transition is 0.01ms; Tab reaches the first figure only after Settings; Esc returns focus; `a` on the body still allows an approval on the Dashboard.

**SEC.** New row **SEC-39**: the workspace stream carries ids and kinds only for step, approval and review events — a planted document title and a tool's arguments never appear in any frame; the route stays behind the token and the origin check. `tests/security/sec-39-workspace-stream.test.ts`.

**Human verification.** Start a workflow; watch its figure walk to the workshop; open the popover; cancel it from there. Run the delegator with nothing granted; a figure at the town hall door with a bubble; decide from the popover. Leave for an hour with a schedule due; come back; the board says who finished.
