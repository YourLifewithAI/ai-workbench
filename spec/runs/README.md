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
