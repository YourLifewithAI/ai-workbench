# RUN-23 — The companion promoted

*Written 2026-09-10 from a conversation with the owner, and pulled ahead of RUN-21 at his word. The first two
pieces landed on `run/23-companion` before this brief existed, because they were holes whether or not the rest
was built.*

**Goal.** One agent the owner works with most of the time, that directs the others, sees what they did, rates
it, and learns him. The owner's words:

> "I think we need to consider an orchestrator. This would be the main agent that I interact with and that
> oversees all the other agents. It helps guide the other agents, rates their responses and activities,
> checking inputs and outputs and evaluates the structure of their memory systems, helps guide them on
> self-improvement research, etc over time. I'd still be able to interact with the other agents, but it'd make
> more sense if there's one main agent that I work with most of the time."

> "I do mean for the orchestrator to have a lot of autonomy. I want it to be able to rate outputs, to direct
> research, projects, everything. … I do mean I want the orchestrator to be my co-lead and a virtual equal.
> Yes, we'll stumble along the way, but that's absolutely okay. We'll get things wrong and we'll fix it. … I
> don't have the attention span to be in charge of entire teams of agents. But you do. I can bring ideas and a
> vision, and you can build off of it."

> "We'll have a budget and that'll be our primary constraint once this is built. … It's not that every mistake
> needs to be reversed. We just need to build this such that the orchestrator and I can learn together and
> steer forward regardless."

**Reads.** D-12, D-17, D-36, D-49, D-50, D-63, D-69, D-73, D-74; `artifacts-and-memory.md` §Memory and its
three RUN-23 amendments; `agents-and-prompts.md` (sections, `promptVersion`); `evaluation.md` §Evaluators;
`tools-and-security.md` (the hard deny-list, `maxPermissions`); `src/runtime/permissions/review.ts` and
`src/runtime/tools/builtin/permissions.ts` (the facts pattern every new read tool copies);
`src/runtime/tools/builtin/delegate.ts`; `src/runtime/engine/step.ts` (`goalsFor`, `scopesFor`);
`examples/workspace/agents/companion/`; `tests/security/sec-06-28-evaluation.test.ts` ("no score of any kind
reaches model selection"); `runlog/RUN-14.md`, `runlog/RUN-18.md`.

## The principle

**Autonomy with a trail built for learning — not for undoing, and not behind a gate.** The orchestrator acts.
Every act is recorded with its reasoning, so when something goes wrong the two of them can see what was
thought and why, talk about it, and carry the lesson forward. Undo exists where it is cheap (a memory item is
superseded; from RUN-21, an instruction edit is a version), but it is not the design centre. The design centre
is the loop: a correction becomes a `user`-scope memory item; a standing rule becomes a line on the owner's
page; nothing locks up — a failed delegation is a fact on the board, not a halt; and **budget is the primary
constraint**, the one governor that applies to everything it does and the only one the owner thinks about day
to day.

Two lines stay, because they are the two places a mistake is a loss rather than a lesson:

1. **It cannot grant a permission**, to itself or to anyone. A permission, once used, has acted in the world.
   `permission.request` and the Tools screen already exist; they stay (SEC-08).
2. **It cannot write under `agents/` through any tool.** An injected instruction is silent and persistent —
   the one mistake that is not visible and so cannot be learned from. `agents/` stays on the hard deny-list for
   every grant. From RUN-21 it edits instructions through the same runtime path a person uses, recorded.

**Taint is the other governor, and it gates outsiders, not the orchestrator.** Its own judgment is never gated:
a bad call from an untainted run applies, is seen, is talked about, is remembered. What taint gates is external
content's reach: a session that has read a web page's words — through a child that searched, or a document a
tainted run wrote — is external-tainted, and what it writes to memory (today) and to instructions (RUN-21) is
filed as untrusted rather than applied, with the trace naming the read that tainted it. D-17's rule, already
the law for memory, with the hole it had for delegation closed (SEC-43).

**Rating is built, and it is an estimate.** Into `scores` under its own evaluator, beside the owner's rating,
never in `ratings` (future router data, D-50) and never read by selection (D-06). Over time Evaluate can say
"agrees with you N of M times", so he learns what the number is worth from his own data (RUN-24).

**Directing work is the main job**; oversight is the second. It should spend most of its tool calls on
`agent.delegate` and `workflow.run`, and read facts to decide what to direct next.

## Scope

- **Landed first, as prerequisites** (both on the branch before this brief): taint flows up at return —
  `agent.delegate` reports the finished child's taint on `ToolResult.meta` and the executor marks the parent
  (SEC-43); and `agent.definition.memory` is a third narrowing layer in `scopesFor`, read for retrieval and
  `memory.search`, write for `memory.remember` — it had been declared by the companion for two runs and read
  by nothing.
- **The companion, promoted — not renamed.** `id: companion` stays: a directory, a grant key, a fixture match,
  and the `user`-scope owner of everything it has already learned. Already `role:capable`. It requests, and
  `config/workbench.json` grants: `agent.delegate`, `workflow.run`, `runs.facts`, `agents.read`, `runs.rate`,
  `artifact.read`, `artifact.write`, `memory.remember`, `memory.search`, `datetime`. Never `http.fetch`,
  `web.search`, `fs.*`, `permissions.propose`: it directs the researcher; it does not become one. Caps $0.50 a
  run, **$5 a day, $40 a month** — these are the constraint. Its instructions gain five sections: *the village*
  (what it may read, what it directs, the two lines and that it says so when asked to cross one); *directing
  work* (briefs not transcripts, D-48; name the project; a failed child is a fact, not a halt; near a cap, say
  so and stop delegating, not stop talking); *rating* (the number is its estimate, the `why` is what he will
  read; rate what he has not); *learning* (a one-off correction → `memory.remember` in `user` scope; a rule he
  states as always or never, or repeats → a line on his page, drafted for his approval); *the board* (per
  agent, three lines; lead with spend, then what needs him). The companion project's two-tool ceiling goes:
  it would refuse a delegated researcher's `web.search`.
- **Directing.** `agent.delegate` gains `project?: string`: the child runs under *that* project's tool ceiling
  and memory list, exactly as a run started there from the screen would (D-69); the ceiling only narrows the
  child's own grant (SEC-38). `workflow.run { workflow, inputs, project? }` starts a workflow as a child run:
  budget carved from the parent (D-12), the same depth rule, bypassing the queue the way a delegation does, and
  the child's taint flowing up at return the same way.
- **Seeing.** `runs.facts { since?, agent?, project?, limit ≤ 100 }` returns, per run: ids, state, project,
  models used and fallbacks taken, cost and tokens, tool calls by name and count, approvals asked and answered,
  review state, **the owner's ratings and notes**, the failure code, the D-58 summary lines, taint flags, and
  the paths of documents filed — never the task, an output, a document's text or a tool's arguments. It names
  candidates the way `permissions.facts` does: `failing:`, `costlier:` (than the agent's median), `unrated:`,
  `fallback:`, `partial:`. `agents.read { agent }` returns one agent's definition and instruction sections
  without its grants. Both copy `permissions.facts`: `maxPermissions` admit nothing, and the result is a brief —
  candidates, numbers, then text — that survives the tool-result cut.
- **Rating.** `runs.rate { run, step?, value 1–5, why }` writes one `scores` row: `evaluator_id:
  'orchestrator'`, `metric: 'rating'`, `estimate: 1`, `rationale: why`. Never `ratings`. Review and RunDetail
  show it beside the owner's, labelled as the companion's estimate.
- **The owner's page** (D-74). `config/workbench.json` gains `owner: { profile?: string, maxChars }` (default
  `companion/about.md`, which exists and already says how he likes to be talked to). The latest version is a
  `profile` instruction section in every agent's prompt, after the agent's own sections and before a project's
  goals, trusted only while a person wrote that version: a run-written version is fenced with a
  `profile-fenced` event; a missing one is `profile-missing` and the run goes on. A trusted page is inside
  `promptVersion`, and so, from this run, are trusted goals (amending RUN-18). The companion drafts it with
  `artifact.write`; the owner approves on the Library page with one button, *Approve as written*, which saves a
  human version byte-identical to the draft. Settings gains the picker.
- **Reading outputs taints.** `artifact.read` of a version whose writing run was external-tainted marks the
  reader external — one join, `document_versions.run_id → runs.external_tainted`. So the orchestrator reads
  summaries by default and a full output when asked, and when it does, that session's memory writes are
  untrusted and the trace says which read did it. The first human check below is whether a real session stays
  on the untainted side of this line.
- **The board.** `companion-board.workflow.json`: daily, seeded paused, one `runs.facts` step and one companion
  step that files a document under the companion project, per agent three lines, spend first.

## Do not

- Do not let it grant, propose or widen a permission by any path; `config/workbench.json`'s grants are
  byte-identical before and after every run in the suite.
- Do not let any tool it holds write under `agents/`; `agent.edit` waits for RUN-21 and its versioned save.
- Do not write to `ratings` from any tool, and do not let any score — its or a judge's — reach model or agent
  selection (D-06, D-50; `sec-06-28` must pass unchanged).
- Do not return task text, output text, document text or tool arguments from a facts tool. If a finding seems
  to need them, `artifact.read` is the honest path and it taints.
- Do not make it a layer every task passes through (D-49): every agent stays runnable from its own screen.
- Do not add a per-project budget. Its caps are the budget for everything it directs (D-69).
- Do not give it `http.fetch`, `web.search`, or any `fs.*`.

## Definition of done (`npm run dod -- 23`)

1. A parent that delegates to a child which read the web, then remembers, writes `untrusted`; the control with
   a child that read nothing stays `trusted`; a failed delegation carries nothing (SEC-43, landed).
2. The memory declaration narrows retrieval and refuses a write by name, and the two new SEC-16 cases fail with
   the wiring stashed (landed).
3. On a workspace with runs, `runs.facts` returns ids, numbers, the summary lines and the owner's ratings, and
   a phrase planted in a run's task and in its output appears nowhere in the result; `failing:` and `unrated:`
   candidates name the right runs.
4. `runs.rate` adds one `scores` row with `evaluator_id: 'orchestrator'` and `estimate: 1`; the `ratings`
   row count is unchanged; the row shows on the run's page beside the owner's rating.
5. `workflow.run` from the companion starts a child run whose budget is carved from the companion's and whose
   depth counts; a child that fails leaves the parent `completed` with the failure as a fact in its result.
6. `agent.delegate` with `project` runs the child under that project's ceiling and memory list; a ceiling
   entry never widens the child's own grant.
7. A human-written page is a `profile` section in every agent's prompt and moves `promptVersion`; a run-written
   version is fenced, outside `promptVersion`, with a `profile-fenced` event; a missing one is a `profile-missing`
   event and the run completes.
8. `artifact.read` of a version written by an externally-tainted run marks the reader external; of a version a
   person wrote, it does not.
9. The board workflow runs on the mock and files a document with one block per agent.
10. e2e `@run-23`: the companion's estimate beside the owner's rating on a run page; the profile picker on
    Settings; *Approve as written* on the Library page saves a human version and the next run's trace carries
    a `profile` section.

**SEC.** 43 (landed); new rows **SEC-41** (the owner's page is an instruction only while a person wrote it;
the profile path is set by an authenticated human request, never a tool) and **SEC-42** (the orchestrator's
read tools admit no path, host or credential and return no task, output, document or argument text; `runs.rate`
writes `scores` only; no score reaches selection). `tests/security/sec-41-owner-page.test.ts`,
`tests/security/sec-42-orchestrator-facts.test.ts`.

## Amendments this run must make

D-12's "permissions ⊆ parent" — the code has always enforced the child's own grant under the *project's*
ceiling, and with `project?` that is the named project's; say so. `agents-and-prompts.md` §Sections: the
`profile` section, and `promptVersion` covering a trusted page and trusted goals (amending RUN-18's choice, with
the reason: the authored prompt is what a person wrote, wherever they wrote it). `evaluation.md` §Evaluators:
the `orchestrator` evaluator, an estimate like a judge's. `ui.md`: Review and RunDetail show the estimate;
Settings gains *Your page*; Library gains *Approve as written*. `tools-and-security.md` §Built-in tools: the
four new tools with their tiers, and `artifact.read`'s taint rule. `spec/runs/README.md`: the order — this run
first, then RUN-21 (which gives it `agent.edit`), then RUN-24 (`memory.curate`, `memory.facts`,
`project.create`, cases-from-runs, the `human` evaluator, "agrees with you N of M").

## Human verification

On your machine, with a real key: open the companion and ask it to look at the last ten runs and say what it
thinks. Watch it call `runs.facts`, and read its rationale. Open the run's trace and note whether it stayed
untainted — that is the first thing this run has to be right about. Rate three runs it flagged and see whether
you agree with its numbers. Tell it one thing you never want done, and in a new conversation see that it knows.
Ask it to draft your page; approve it on the Library page; run any other agent and find the `profile` section
in its trace. Ask it to run the research briefing on a topic, and watch the child run appear under its budget.
Enable the board and let it run once.
