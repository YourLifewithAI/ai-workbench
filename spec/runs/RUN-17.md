# RUN-17 — The coding run

**Goal.** A brief in `spec/runs/` is dispatched to the workbench, and what comes back is a branch a person merges and a handoff in `runlog/` — the run protocol, executed by a workbench agent (D-67).

**Reads.** `runs/README.md` (the protocol; it is the specification of this workflow), `runs/TEMPLATE-handoff.md`, `workflows-and-execution.md` (steps, `review: 'blocking'`, budgets), `tools-and-security.md` (the RUN-16 amendment), D-14, D-20, D-49, D-66, D-67, `runlog/RUN-16.md`, `runlog/RUN-05.md` (blocking gates and resume).

**Why now.** RUN-16 gives an agent the tools; this run gives it the job. The protocol was written for coding agents and has only ever been executed by one outside the workbench. The owner wants to move off that harness entirely, and the honest way to find out what the workbench is missing is to make it do the work its own protocol describes.

**Scope.**
- **`coding-run.workflow.json`**, shipped in the example workspace. Inputs: `brief` (a repository-relative path), `repo` (the granted path). Steps:
  1. **`read`** — the `mechanic` reads `AGENTS.md`, `STATUS.md`, the brief, and every file under the brief's *Reads* list, and produces a plan as a document: the DoD items in order, the files it expects to touch, and the branch name `run/nn-<name>`.
  2. **`implement`** — one agent step with a large tool budget: branch, then loop *edit → `check` → read the failure → edit* until `check` returns `ok: true` or the budget's wrap-up turn arrives. The wrap-up commits what exists and says plainly which DoD items are not met.
  3. **`handoff`** — writes `runlog/RUN-nn.md` from the template as a repository file *and* as a workspace document, commits it, pushes the branch.
  4. **`hand-to-human`** — a `review: 'blocking'` step whose text is the branch name, the check result, and the unmet items. The person opens the pull request and merges, or rejects with feedback, which re-runs `implement` with the feedback appended to its task (D-14).
- **Budgets that mean something.** The shipped workflow sets `maxModelCalls`, `maxToolCalls`, `maxCostUsd` and `maxWallClockMs` for `implement` to numbers a real run needs, and the run form shows them. A run that hits a cap ends with a wrap-up commit and an honest handoff, never a silent stop.
- **The handoff is the protocol's handoff.** Same sections as the template, *Verification transcript* filled from the actual `check` output, *Known gaps* listing unmet DoD items by number. `STATUS.md` is updated to `RUN-nn: awaiting verification @ <sha>` by the run, as the protocol says.
- **CLI:** nothing new. `workbench run workflow coding-run --input brief=spec/runs/RUN-13.md --input repo=/path/to/checkout`. The blocking review is answered in Review, as any other.
- **Model-agnostic by construction.** `mechanic`'s `modelPolicy` names its candidates and fallbacks like any agent; the workflow sets none. The same brief can therefore be run on two models and compared in Evaluate.

**Do not.**
- Do not create the pull request from inside the run in this iteration. The branch is pushed; the person opens the PR. A `github` tool is a separate decision with its own token to hold, and holding it is not this run's to decide.
- Do not merge, ever (SEC-34 already forbids it; the workflow must not want to).
- Do not let the agent edit `spec/runs/*.md` — briefs are the human's (protocol: "Briefs are not amended by run agents"). A repository-relative deny for that directory is set in the shipped grant.
- Do not skip, disable, or quarantine a test to make `check` green; the instructions say so, and the review step shows the diff to `tests/` separately so a person can see it.
- Do not run unattended: no schedule on this workflow.

**Definition of done** (`npm run dod -- 17`).
1. On the mock provider, against a fixture repository whose gate fails once and then passes after a scripted edit, `coding-run` produces: a plan document, a branch, two commits (the fix and the handoff), a pushed branch on the bare fixture remote, a `runlog/RUN-99.md` with the transcript section holding the real `check` output, and a run parked at `waiting_review` whose text names the branch.
2. A fixture whose gate never passes ends within budget with a wrap-up commit, a handoff listing the unmet items by number, and the same blocking review — not a failed run.
3. Rejecting the review with feedback re-runs `implement` with the feedback in its task; continuing completes the run.
4. An attempt by the scripted agent to write under `spec/runs/` is refused and shows in the trace.
5. The workflow validates with no D-49 warnings and its budgets are visible on the run form.
6. e2e: the run form for `coding-run` shows the two inputs and the budgets; the parked review shows the branch name.

**SEC.** 33 · 34 · 35 re-verified end to end through the workflow. Note for the handoff: the parked step is a *review*, not an approval — it does not expire into a denial the way SEC-12 approvals do (RUN-05), so a branch waits for the person indefinitely, which is the intended behaviour for code.

**Human verification.** This run's real verification is the next two: dispatch RUN-13 and then RUN-14 through `coding-run` on a real model, read the handoffs, merge the branches. Note what the harness had that the workbench did not; each item is a maintenance branch or a brief.
