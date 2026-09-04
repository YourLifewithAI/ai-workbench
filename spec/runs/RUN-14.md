# RUN-14 — The standing permissions review

**Goal.** Something notices, on a schedule, that the grant matrix has drifted from what the owner actually meant — and says so, in the Review queue, without ever being able to change it.

**Reads.** `tools-and-security.md`, `sec-catalog.md` (SEC-08), `ui.md` (Review, Tools), `workflows-and-execution.md`, D-63, `runlog/RUN-06.md`.

**Scope.**
- A `permissions-review` workflow shipped in the example workspace, scheduled weekly by default but disabled until the owner enables it.
- A `auditor` agent whose whole job is this. It reads: the grant matrix, the tool catalogue, and run **metadata** — which grants were exercised and how often, how often an approval was requested and how it was answered, when each grant was made. It reads no trace content, no memory, no documents. Its permissions row is the smallest in the workspace and the screen should show that.
- Findings it is asked to look for, each as a row with the exact toggle to flip:
  - **A grant nobody used.** Granted 40 days ago, exercised zero times. The safest grant is the one you take back.
  - **A grant the instructions no longer justify.** The agent's `instructions.md` stopped mentioning the web three edits ago; it still holds `http.fetch`.
  - **Reach wider than the need.** An agent granted a network tool under a policy that admits hosts the tool has never been asked for.
  - **Approval fatigue.** A tool that always asks and has been approved 30 times in a row without a rejection — either it should be granted outright or the owner has stopped reading it, and both are worth saying out loud.
  - **Undecided.** A tool that exists (new build, new plugin, new MCP server) that no agent has ever been granted or explicitly denied.
- Output: one review item per finding, with the evidence that produced it and a control that applies the change **when the person clicks it**. Applying is an ordinary matrix write by the human, indistinguishable in the audit log from one made on the Tools screen.
- Dismissing a finding records the dismissal, so the next review does not raise it again until the underlying facts change.

**Do not.**
- Do not let any agent write to the grant matrix, ever, under any flag (D-63, SEC-08). The reviewer proposes; the person applies.
- Do not give the auditor read access to traces, memory, documents or credentials. If a finding seems to need them, the finding is out of scope.
- Do not auto-apply "safe" revocations. A revocation that breaks tomorrow's scheduled run is not safe, and the owner is the one who knows that.
- Do not turn it on by default. A workbench that starts nagging on day one teaches you to dismiss it.

**Definition of done** (`npm run dod -- 14`).
1. A workspace with a granted-but-never-used tool produces exactly that finding, naming the grant, the age and the zero.
2. Applying a finding flips the matrix and the next review no longer raises it.
3. Dismissing a finding suppresses it until the underlying counts change, then it returns.
4. The auditor's own permissions row grants it no tool that reads content; a SEC case asserts a run of `permissions-review` produces no `artifact.read`, `memory.search`, `knowledge.search` or `fs.read` call.
5. A SEC case asserts no code path lets a run write `permissions` — the matrix write is reachable only from an authenticated human request.
6. e2e: the review lands in the queue, one finding is applied, one is dismissed.

**SEC.** 08, plus a new case: the auditor cannot read what it is auditing the access to.

**Human verification.** Enable it, let it run once against a workspace you have been using for a fortnight, and see whether its findings match the grants you had already half-decided to take back.
