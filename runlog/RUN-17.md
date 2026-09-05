# RUN-17 handoff — The coding run

Branch `run/17-coding-run` · code at `fed2ff2` · brief: `spec/runs/RUN-17.md` · decision D-67.

## Built
- `examples/workspace/workflows/coding-run.workflow.json` — eight steps, one agent. `read` (the Mechanic reads `AGENTS.md`, `STATUS.md`, the brief and its *Reads*, and answers JSON: run number, branch name, the DoD items, the files, a plan; filed as `<runId>/plan.json` in the `coding` project) → `implement` (branch, edit, `check`, edit, commit; its own budget of 120 model calls · 400 tool calls · $10 · 90 min) → `verify` (a **tool step** running `check`, so the verdict in the handoff is the gate's own) → `handoff` (the document from the template, `STATUS.md` updated; filed as `<runId>/RUN-nn.md`) → `file-handoff` (a tool step writing `runlog/RUN-nn.md` with the recorded transcript appended) → `commit` → `push` (tool steps) → `hand-to-human` (`review: 'blocking'`, `onReject: 'implement'`: the note is the branch, the check result and the unmet items by number). Ceiling: the ten repository tools and `repos: [{ path: "/", branches: "run/*", deny: ["spec/runs"] }]`. No schedule.
- **`onReject`** on a blocking step (`src/shared/workflow.ts`, `engine/workflow-run.ts`): a rejection re-runs the named ancestor with the feedback in its task; everything downstream, the gate included, runs again and the gate parks a second time. Validated (must be upstream, must be blocking). A rejection made before a restart is picked up on resume the same way. The gate itself re-runs plain: the step it named answers the feedback.
- **A step's own budget ends the step, not the run** (`engine/budget.ts`, `engine/step.ts`): `BudgetStop.scope`, a wrap-up per budget rather than one per run, the wrap-up committed as the step's output flagged `partial`, and a step-level hard stop leaving the stop's words as the output. The run's limits end the run exactly as before.
- **A tool step may name `agent`** (`ToolStep.agent`): the grant it runs under. Widening nothing — the call is one that agent could make — and it is how the workflow commits and pushes whether or not the model remembers to.
- **`RepoGrant.deny`** (`src/shared/repo.ts`, `security/repoPolicy.ts`): repository-relative prefixes a grant refuses to write under; denies add up across layers. The Tools screen shows them beside the branches.
- `git.commit` with nothing to commit answers `committed: false` rather than failing, so a re-run that changed nothing carries on to the push.
- `GET /workflows/:id` returns `budgets`; the run form shows them under the inputs with the rule in one line.
- `examples/workspace/projects/coding/`, the Mechanic's instructions for the protocol, and `tests/helpers/repo.ts` holding the fixture repository, the protocol files and the scripted conversations both DoD suites and the e2e setup use.

## Not built (deliberate)
- Pull-request creation from inside the run — the brief's *Do not*. The branch is pushed; the person opens the PR.
- Merging — nothing here can (SEC-34), and the workflow does not want to.
- A schedule on `coding-run`: never unattended.
- A per-step deny of `tests/` or a diff view of it at the gate. The instructions say not to skip a test; the reviewer reads the diff on GitHub, where it is already separated by file.

## Deviations from the brief
- **Eight steps, not four.** The brief's four are here; the other four are tool steps that do what the brief asked the agent steps to do — run the gate, write the handoff file, commit, push — so that the transcript in the handoff is the gate's own output and the push happens even when the model's last turn is a wrap-up with no tools. Amended in `workflows-and-execution.md` (tool steps under a named agent).
- **The wrap-up does not commit; the workflow does.** A wrap-up turn has no tools by design (D-14). The brief's "the wrap-up commits what exists" is done by `commit`, which stages everything including the attempt, so a run that hit its cap still ends with a commit and an honest handoff.
- **`implement`'s budget ends `implement`, not the run.** The brief asks for "a wrap-up commit and an honest handoff, never a silent stop"; the executor's rule was that any budget stop fails the run. Amended: a step's own limit ends the step with a partial output; the run's ends the run.
- **`onReject`** did not exist: a rejection re-ran the gate itself. Amended.
- **Denies on a repository grant** did not exist; the brief's "repository-relative deny for that directory is set in the shipped grant" needed one. Amended in `tools-and-security.md`.

## Verification transcript
```
npm run check                          typecheck · lint · unit 65 · security 143 · contract 51 · route-drift 73 routes · secret-scan clean
npm run dod -- 17                      4 passed (DoD 1, 2, 3, 5), then the @run-17 e2e case
npx vitest run --project dod           108 passed | 2 skipped (16 suites; the two skips are live-only)
npm run e2e                            34 passed
```
DoD 1: a plan document, `run/99-fixture`, two commits by `mechanic` (the fix, then `RUN-99 handoff and STATUS`), the branch on the bare remote and `main` not, `runlog/RUN-99.md` holding `PASS: app is fixed` under *Verification transcript (recorded by the workflow)*, `STATUS.md` updated, the review parked at `hand-to-human` with `Branch: run/99-fixture` as its first line. DoD 2: with `implement` capped at six calls against a gate that never passes, the step ends `partial` with "Not met: 1, 2", the workflow makes the one commit carrying the attempt, the handoff and STATUS, the handoff's *Known gaps* names both items, and the run parks — no `step-failed`, not a failed run. DoD 3: reject with feedback → `implement` runs a second time with the feedback in its task and not in the first, the extra commit and a re-recorded handoff are pushed, the gate parks with `attempt: 2`; continue → `completed`, outputs carry the branch and the note. DoD 4: inside DoD 1, `repo.write spec/runs/RUN-99.md` is refused, `repo-decided` says why, the brief is unchanged. DoD 5: no smells, the eight steps in order, the gate blocking, `implement`'s four caps on the detail, no schedule. DoD 6: `@run-17` in `tests/e2e/workflows.spec.ts` — the form's two inputs and budgets, then the parked review card naming the branch, then *Continue the run*.

## SEC tests added
- SEC-33, 34 and 35 re-verified end to end through the workflow: DoD 1 (the deny on `spec/runs/`, the push of a run branch and only that), DoD 2 and 3 (`check` run by a tool step under the same grant; the commit and push by name). `tests/security/sec-33-35-repos.test.ts` gained the `deny` intersection and the prefix rule (a sibling whose name is a prefix is not under it).
- Note for the record: the parked step is a *review*, not an approval. It does not expire into a denial the way SEC-12 approvals do (RUN-05); a branch waits for the person indefinitely, which is the intended behaviour for code.

## Spec amendments made
- `spec/workflows-and-execution.md` — `onReject`; a step's own budget ends the step; tool steps under a named agent.
- `spec/tools-and-security.md` — `deny` on a repository grant.
- `spec/api-and-cli.md` — `budgets` on the workflow detail; how a coding run is started from the CLI.
- `spec/ui.md` — budgets on the run form; denies on the Tools screen.

## Known gaps
- The handoff's own *Verification transcript* section is the model's; the workflow appends the recorded one below it. Two sections, one honest by construction. A later run could drop the model's.
- `hand-to-human`'s note is model text; the facts it summarises (branch, check result) are in its *input*, which the review card does not show. The DoD asserts the fixture's text; a real model could misstate the branch. A review card that shows the step's task beside its output would close that.
- A coding run against this repository takes `npm run check` seriously: 25 minutes per `check` on a cold machine, several checks per run. The shipped `implement` budget (90 min wall clock, narrowed by the workspace's 30) will need the workspace's `maxWallClockMs` raised in Settings before the first real dispatch. That is the person's dial, on purpose.

## Notes for the next run
- The next two runs are RUN-13 and RUN-14, **dispatched through `coding-run` on a real model**: grant the Mechanic this checkout with `run/*`, raise `budgets.maxWallClockMs` in Settings, then `workbench run workflow coding-run --input brief=spec/runs/RUN-13.md --input repo=/abs/ai-workbench`. What the harness had that the workbench does not is the finding; each item is a maintenance branch or a brief.
- The fixture pieces for a scripted coding run — `protocolRepo`, `protocolScripts`, `IMPLEMENT_GREEN` — are in `tests/helpers/repo.ts` and are what the e2e global setup uses too.
- A gate's `onReject` target gets the feedback; the gate re-runs without it. If a later workflow wants both, `carried` in `WorkflowExecutor.execute` is the one place to change.

## Human verification script
1. `npm run build && node dist/cli.js init ~/wb-17 && node dist/cli.js start --workspace ~/wb-17`.
2. In `~/wb-17/config/workbench.json`, grant the Mechanic this checkout: the ten repository tools and `"repos": [{ "path": "/abs/path/to/ai-workbench", "branches": "run/*" }]`. In Settings, raise `maxWallClockMs` to at least two hours. Restart.
3. Open **Workflows → Coding run**. Expect *Brief* and *Repository* on the form, and under **Budgets** the line for `implement`.
4. Dispatch RUN-13 on a real model: brief `spec/runs/RUN-13.md`, repository the path above. Watch the graph fill in: `read`, `implement` (long), `verify`, `handoff`, then the three tool steps, then `hand-to-human` marked *waits for you*.
5. Open **Review**. Expect the card's first line to be `Branch: run/13-…` and the check result on the second. Open the branch on GitHub, read `runlog/RUN-13.md`, read the diff.
6. Reject it with one sentence of feedback. Expect `implement` to run again with your sentence in its task (open the trace, find the second `model-started` on `implement`), a new push, and the card back with *attempt 2*.
7. Continue. Expect the run `completed` and the branch unchanged since the last push. Open the pull request yourself; nothing in the run can.
8. Then RUN-14 the same way. Write down every place the workbench was slower or blinder than the harness that built it: that list is the next brief.
