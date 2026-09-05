# Run protocol

*Prose cap: 500 words.*

A run is one coding session by one agent (or a coordinator with parallel slices) that turns a brief into working, verified code. Continuity lives in files, never in chat memory. Recommended order: 00–06, then 12 (phone), then 07–11, so approvals reach the phone before the first live briefing.

## The files

| File | Written by | Purpose |
|---|---|---|
| `AGENTS.md` | spec | conventions, gates, where to start |
| `STATUS.md` | run agent, then human | current run, gate state, last verified commit |
| `spec/runs/RUN-nn.md` | human only | the brief |
| `runlog/RUN-nn.md` | run agent | the handoff (template: `spec/runs/TEMPLATE-handoff.md`) |
| `runlog/RUN-nn.feedback.md` | human, optional | what to fix before acceptance |

## Start

RUN-00 begins in the new, otherwise empty `ai-workbench` repository whose first commit contains only `spec/`. If the working directory holds anything else (for instance a Next.js app), you are in the wrong repository: stop and say so.

1. Read `AGENTS.md`, `STATUS.md`, this file, `spec/runs/RUN-nn.md`, `runlog/RUN-(nn-1).md` (RUN-00 has none), then only the spec documents the brief lists under *Reads* (2–6), plus `spec/sec-catalog.md` for the SEC ids the brief names and `spec/decisions.md` for any `D-nn` those documents cite. Do not read the rest of `spec/`. `spec/runs/TEMPLATE-handoff.md` is read at the end.
2. Create branch `run/nn-<name>`. Run `npm run check`. If it is red, fix the baseline first and record that under *Deviations*.
3. The brief's *Definition of done* is your work plan, in that order. Write each DoD test in `tests/dod/RUN-nn.test.ts` before or alongside the feature; add the brief's SEC tests to `tests/security/`.

## During

- Keep `npm run check` green between commits. Commit messages: `run-nn: <what>`.
- Never touch anything on the brief's *Do not* list; the never-rules in `AGENTS.md` apply throughout.
- If the brief conflicts with reality (a library changed, a decision is unimplementable), implement the narrowest workable version and amend the affected spec document in the same PR with `> Amendment (RUN-nn, date): …`. Briefs are not amended by run agents; propose brief changes in the handoff.
- Everything must work with `--provider mock` and no keys. Live tests are opt-in.

## End

The run is complete only when `npm run check`, `npm run dod -- nn`, and every SEC test the brief lists are green, and every UI screen the brief names is reachable. Then write `runlog/RUN-nn.md` from the template, including the verification transcript and a human verification script, and set `STATUS.md` to `RUN-nn: awaiting verification @ <sha>`. Open one PR per run.

## Human verification

The owner runs `npm run check`, `npm run dod -- nn`, and the handoff's script. Accept → merge, `STATUS.md` = `RUN-nn: verified`. Reject → `runlog/RUN-nn.feedback.md`; the same brief is re-dispatched with "address the feedback in runlog/RUN-nn.feedback.md".

## Teams

Runs are sequential by default. A brief may name *Slices*: module boundaries safe to build in parallel. A coordinator dispatches one agent per slice on `run/nn-<slice>` branches, merges with `check` green, and writes the single handoff. Slices never share files.

## Why this works across fresh sessions

Everything an agent needs is in at most ten bounded files. Done is a command, not a judgment. The handoff's transcript lets the next session trust the baseline. The mock provider makes every result reproducible.

> Amendment (owner review, 2026-09-04): RUN-13 (editing a workflow) and RUN-14 (the standing permissions
> review) are planned, not scheduled. Both came out of the first human walk of the ten-minute path. Neither
> blocks anything already built; take them in either order, or neither.

> Amendment (owner review, 2026-09-04): RUN-15 (the catalog learns what exists) is planned, not
> scheduled. It came from the first live run failing on a retired model. Like RUN-13 and RUN-14 it blocks
> nothing already built.

> Amendment (RUN-19, 2026-09-04): not every branch is a numbered run. Once the brief list was exhausted,
> work continued as maintenance branches with no brief of their own — `run/16-cred-message` through
> `run/21-rerun` — each one a defect found by using the thing or by a platform that had never run the suite.
> They keep the branch naming and the gates (`npm run check`, the DoD suites, `npm run e2e`, one PR each) and
> drop only what a brief provides: a *Reads* list, a *Do not* list, and a definition of done written in
> advance. Their record is the commit message and the PR, not a `runlog/` handoff, because there is no brief
> for a handoff to answer. A maintenance branch that turns out to need a brief — a real feature, a decision
> nobody has made — stops and becomes one (that is how RUN-13, RUN-14 and RUN-15 were written).

> Amendment (owner decision, 2026-09-05): the next runs are **15, 16, 17, then 13 and 14** — and 13 and 14 are
> executed *by the workbench*, not by the coding harness this project was built in (D-67). RUN-15 first because
> a key for a second provider is useless until the catalog can learn what that provider offers. RUN-16 gives an
> agent a repository, git, and the repository's own check command under a grant a person wrote (D-66). RUN-17
> ships `coding-run`, the workflow that reads a brief and drives it to a branch a person merges. From then on
> the protocol above is unchanged and the agent running it is different: a brief is dispatched with
> `workbench run workflow coding-run --input brief=spec/runs/RUN-nn.md`, the handoff lands in `runlog/` as a
> document, and the person's part is the merge. The first two briefs to go through it are the two already
> written, which is also how RUN-17 is verified.

> Amendment (owner decision, 2026-09-05, later the same day): RUN-13 and RUN-14 are built **here**, by the
> coding harness, not dispatched through the workbench. The coding run (RUN-17) is merged and verified against
> fixtures and stays parked for three to six months: the owner's call is to finish the buildout — functional and
> then aesthetic — with the one model he trusts today, and to dogfood when model capability and price have moved.
> The protocol is unchanged; only who executes the next briefs is.

> Amendment (2026-09-05): after RUN-14, the remaining work is listed in `FINISH.md` — functional items first,
> then the look of the thing, then what is parked. Items there are built in the order it gives, as maintenance
> branches or run briefs, unless the owner strikes or reorders them.
