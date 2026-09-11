# RUN-24 — The pulse

*Written 2026-09-11, after the owner shared a loop-orchestrator setup from r/ClaudeAI and asked how it applied.
Most of it the workbench already had, and ours is stronger on trust and on budget. Five things were missing,
and the owner said: "Go ahead and fold what you suggested into the workbench." This is that. What RUN-24 was
going to hold — `memory.curate`, `memory.facts`, `project.create`, cases from runs, the `human` evaluator,
"agrees with you N of M" — moves to RUN-25.*

**Goal.** The orchestrator stops waiting to be asked. On a loop it reads what happened and what is owed,
staffs what is ready, files what it found, and asks the owner only what the owner has to decide — and every
one of those acts is a row the owner can see, dedupe protects from nagging, and budget bounds. The post's
words for the shape: "the ability to message your agent on a loop", "a locally running database that your
orchestrator manages", "tossing out bad code and having it start over instead of worrying about driving every
PR. Like a real manager."

**Reads.** D-12, D-13, D-17, D-63, D-73, D-74, D-75, D-76; `spec/runs/RUN-23.md`; `runlog/RUN-23.md`
(*Notes for the next run*); `src/runtime/engine/run.ts` (`childOf`, `settleChild`, `spentSinceUsd`,
`ownCapsOf`); `src/runtime/permissions/store.ts` and `review.ts` (the findings-with-dedupe pattern);
`src/runtime/tools/builtin/orchestrator.ts`; `src/runtime/scheduler/index.ts`;
`examples/workspace/workflows/coding-run.workflow.json`; `tests/helpers/repo.ts`; `tests/dod/RUN-17.test.ts`.

## What applies from the post, and what does not

- **Already here, and stronger:** the mission note is the companion's instruction sections; "add a law when
  it does something you don't like" is D-73's loop with a trust rule his note does not have; the ping is the
  scheduler; review-before-QA is the blocking gate; model-by-complexity is `agent.delegate { model: 'role:…' }`;
  the log scan is `runs.facts`; don't-nag-twice is the auditor's facts hash.
- **Missing, built here:** a work ledger the orchestrator owns; a pulse that acts rather than reports;
  dispatching a child without waiting; a decision put to the owner as options; a plan reviewed by a second
  model before building; spend per agent and the heartbeat where you would look for them.
- **Not copied:** sixteen concurrent sessions (concurrency is a Settings number; the pulse scales by budget),
  and the orchestrator reading email or the web itself (a researcher child does, the parent takes on the taint
  at return, and that pulse's instruction edits are filed rather than applied — the governor, working).

## Scope

- **Caps count descendants first.** The companion's daily and monthly caps counted only its own model calls;
  a delegated researcher's spend counted against the workspace and the researcher, never the companion.
  `spentSinceUsd(since, agentId)` walks `runs.parent_run_id`, so a call in any descendant of an agent's run
  counts against that agent's own caps. Per-run budgets already carved; the day and the month now do too.
  Detached children make this matter, so it lands before them.
- **The ledger (D-75).** `work_items`: a kind (`task`, `bug`, `decision`, `note`), a project, a title and detail,
  a state (`backlog`, `staffed`, `in-review`, `needs-you`, `decided`, `done`, `dropped`), an assignee, a `key`,
  a `trust`, the run that wrote it; `work_runs` links items to the runs that worked them. Tools: `work.file`
  (an open item with the same `key` is refreshed, never duplicated), `work.list`, `work.update`, and
  `owner.ask` — a `decision` in `needs-you` with options and the orchestrator's lean. Trust is the writing
  run's, as memory's is (D-17): an item a tainted run wrote is `untrusted`, shown so, and never an instruction.
  Routes: `GET /work`, `POST /work` (a person files), `PUT /work/:id` (a person moves it or answers).
  Dashboard: decisions under *Needs you* with the options as buttons; a *Work* list; the empty state counts
  them.
- **Detached children (D-76).** `agent.delegate` and `workflow.run` gain `wait` (default true). With
  `wait: false` the child starts and the tool returns its run id at once. The carved budget is charged to the
  parent as a **reservation** at dispatch — the parent's per-run bar shows it, and the caps count the actual
  — the child is not cancelled when the parent ends, depth applies, and nothing flows up at dispatch: the
  child's output taints whoever reads it (RUN-23's `artifact.read` rule), and `runs.facts` shows it next pulse.
- **The pulse.** `companion-pulse.workflow.json`, every two hours, seeded paused, project `companion`: the
  facts, the open ledger, then one companion step that acts and files `pulse/<runId>.md` — even when clean.
  The companion's instructions gain *the pulse*; its grants gain the four ledger tools.
- **The heartbeat and the spend.** An agent's card shows the schedule that wakes it (next fire, last fire,
  on or off) and what it has spent today and this month against its caps, descendants included.
- **Plan review in the coding run.** A `review-plan` step between `read` and `implement`: the Reviewer, on
  `role:capable`, reads the brief and the Mechanic's plan and answers `proceed` or `revise` with issues; the
  Mechanic builds with the issues in front of it. The post's law 1, as a workflow step rather than a rule.

## Do not

- Do not let any ledger text reach an instruction section, and do not let `work.*` or `owner.ask` admit a
  path, a host or a credential (SEC-44).
- Do not let a detached child escape budget: its carve is charged, its spend counts against its ancestors'
  own caps, its depth counts (SEC-46).
- Do not let the pulse read outside the workspace itself: no `http.fetch`, no `web.search` for the companion.
- Do not raise concurrency by default. `maxConcurrentRuns` stays a Settings number.
- Do not ticket noise: an item is filed once per `key`, refreshed after, and the instructions say so.

## Definition of done (`npm run dod -- 24`)

1. A companion run whose child spent X counts X against the companion's daily and monthly caps, and against
   the child agent's own; a run with no ancestor counts as before.
2. `work.file` twice with one `key` is one item, refreshed; an item written by an external-tainted run is
   `untrusted`; a person's `PUT` moves state and answers a decision.
3. `owner.ask` files a `decision` in `needs-you` with options; the Dashboard shows it with the options as
   buttons; answering it is one click, and the next `work.list` returns it `decided` with the answer.
4. `agent.delegate { wait: false }` returns at once with the child's run id; the parent's `spent` carries the
   reservation; the child completes after the parent; `runs.facts` lists it under the parent.
5. The pulse workflow ships seeded paused, runs on the mock, files an item and a decision, and writes
   `pulse/<runId>.md`.
6. The companion's card shows its heartbeat (next and last fire) and its spend today and this month against
   its caps.
7. The coding run's `review-plan` step runs on the mock and the Mechanic's implement input carries its issues;
   DoD 17 stays green.
8. e2e `@run-24`: a decision answered on the Dashboard; spend and heartbeat on the Agents screen.

**SEC.** New rows **SEC-44** (ledger text is content: trust from the writing run, never an instruction; the
four tools admit nothing) and **SEC-46** (a detached child cannot escape budget). SEC-45 stays RUN-21's.
`tests/security/sec-44-work-ledger.test.ts`, `tests/security/sec-46-detached-budget.test.ts`.

## Amendments this run must make

`data-model.md` (migration `0014`), `tools-and-security.md` (the four tools), `workflows-and-execution.md`
(detached children; the coding run's step), `agents-and-prompts.md` (the pulse section, the grants),
`api-and-cli.md` (three routes, the agent summary's `heartbeat` and `spend`), `ui.md` (Dashboard decisions and
work; the agent card), `spec/runs/README.md` (RUN-25 named), `spec/runs/FINISH.md` (O2).

## Human verification

Enable the pulse on Workflows and let it fire twice. Open `pulse/…` in the companion project: what it saw,
what it staffed, what it filed. Dashboard: answer one decision, and see the next pulse act on the answer. Agents
→ Companion: the next pulse time and today's spend on its card, with the researcher's runs counted in. Ask the
companion to run the research briefing without waiting, then look at the Dashboard: the child running, the
companion's run already finished.
