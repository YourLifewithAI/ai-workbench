# RUN-05 — Review queue, blocking gates, resume, scheduler, Dashboard

**Goal.** Long-running and recurring work with the human as asynchronous verifier and tastemaker. Runs outlive the browser tab; the owner catches up from the Dashboard.

**Reads.** `workflows-and-execution.md` (lifecycle, scheduler, review), `data-model.md` (reviews, ratings, schedules), `ui.md` (Dashboard, Review), `api-and-cli.md`, `runlog/RUN-04.md`.

**Scope.**
- `reviews`, `ratings`, and `schedules` tables; review queue: unreviewed outputs, rate 1–5, edit → version, reject-with-feedback re-run (≤ 2), re-run downstream from a version; blocking gates (`waiting_review`); schedule editor on the Workflows screen.
- `interrupted` on startup; `runs resume` from the last completed step with no duplicate artifact versions.
- `schedules` table, cron via `croner`, `catchUp`, concurrency limit; scheduled runs are ordinary runs.
- Dashboard per `ui.md`: *Needs you* first (blocking reviews, failures; approvals placeholder until RUN-06), then *Running* with budget bars and Cancel, then *Today* (spend vs cap, next scheduled); network-mode banner with one-click offline; *Pause all*. Review screen with one-keystroke rating (`1`–`5`) and `j`/`k` navigation (D-59).
- `workbench review …`, `workbench runs resume`; SSE reattach by run id on page load.

**Do not.** Add tools, memory, the approvals mechanism itself.

**Definition of done** (`npm run dod -- 05`).
1. With `workbench start --provider mock`, a schedule `* * * * *` for `story-pipeline` produces two runs under a fake clock; `catchUp: once` produces exactly one run after a simulated outage; `none` produces none.
2. `SIGKILL` the runtime mid-workflow in a test; restart marks the run `interrupted`; with the runtime running, `workbench runs resume <id>` completes from the last finished step; artifact versions are not duplicated.
3. A `review: 'blocking'` on Weaver parks the run in `waiting_review`; `continue` via UI and via `workbench review continue` both resume it; reject-with-feedback re-runs Weaver with the feedback appended.
4. Ratings persist and show in the Library.
5. e2e: close and reopen the browser during a run; the Dashboard reattaches to it by id.

**SEC.** 28b. Blocking review gates have no timeout by default; the approval mechanism and its tests arrive in the next run.

**Human verification.** Schedule the pipeline for five minutes from now, close the browser, come back and find it on the Dashboard; rate the output; reject the draft with a note and watch it rewrite.
