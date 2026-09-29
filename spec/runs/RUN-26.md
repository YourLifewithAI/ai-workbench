# RUN-26 — The board: the orchestrator, the agents beneath it, and the room where you talk

*Written 2026-09-12 and rewritten 2026-09-29, from the owner's own words. First, after he started the workbench
and could not find the orchestrator: "Where do we go to discuss things with the orchestrator? I don't see
anywhere in the UI interface by which I would strike up a conversation with the orchestrator, let alone have it
report back to me letting me know what the various agents have been doing. … a lot of this should be coming from
the orchestrator." Then, when the first draft of this brief answered with a house in the village: "Let's take the
graphical interface out of this altogether. Can we turn this into a dashboard instead, with an orchestrator and
various subagents underneath it. Ideally each agent gets a card that I can select that tells me what they've
been doing, how much they've been spending on token usage, how the Orchestrator is rating that agent's activity,
etc." The village is withdrawn; the board is the front door.*

**Goal.** One screen that is the way in, on a desktop and on a phone: the orchestrator across the top — what
happened since he was last here, the conversation, the composer — and every other agent as a card beneath it
that says what it has been doing, what it has spent, and how the orchestrator has rated its work, with his own
ratings beside the orchestrator's and never in their place. Each exchange with the orchestrator is a real run
underneath, with its trace and its cost; the pulse's notes and the decisions it asks for arrive in the same
stream; a card is selectable and opens onto the agent's last runs. The village — RUN-19's map — leaves the
codebase.

**Reads.** D-06, D-12, D-17, D-36, D-46, D-48, D-50, D-58, D-71 (superseded), D-73, D-74, D-75, D-76, D-77,
D-78, D-79; `spec/runs/RUN-23.md` and `RUN-24.md`; `runlog/RUN-24.md` (*Notes for the next run*);
`src/runtime/engine/prompt.ts`, `step.ts` (`history`), `run.ts` (`startAgentRun`, `spentTodayUsd`, `listRuns`);
`src/runtime/conversations/store.ts`; `src/runtime/orchestrator/facts.ts` (what not to call per run);
`src/shared/summary.ts`; `src/runtime/review/store.ts` (`estimatesFor`) and `src/runtime/evaluation/store.ts`
(`addScore`); `src/ui/screens/Dashboard.tsx` (the decision card), `RunDetail.tsx` (how a run is followed),
`Agents.tsx`; `src/ui/App.tsx` (`FrontDoor`), `src/ui/components/Shell.tsx`; commit `ec4afe1^` (the shell before
the village).

## What is wrong today

The companion is reachable at Agents → Companion, where a run form takes one message and answers it, then sends
him to the run's page. Three things are missing and the owner named all three:

- **No conversation.** Every exchange is its own run on its own page. There is no thread to scroll back through,
  and the agent carries nothing of the last exchange but what memory retrieval happens to return.
- **No orchestrator-authored home.** The Dashboard is assembled by the interface from database queries. The
  orchestrator wrote none of it and has nowhere to greet him or say what happened.
- **No view of the agents as a team.** Agents is a list of definitions; the runs are a list of runs; the ratings
  are on each run's page. Nothing says, per agent, what it did this week, what that cost, and whether it was any
  good.

RUN-24 made the orchestrator report — the pulse's note, the ledger, a decision as options — but it reports to a
noticeboard. This run makes it a conversation, and puts the team on one board beneath it.

## Scope

- **A conversation is a thread of runs (D-77).** `conversations(id, title, agent_id, project, created_at,
  updated_at, last_read_at)` and `runs.conversation_id` (migration `0015`, which also indexes `runs.agent_id`).
  Posting a message starts an agent run in the thread; the reply is that run's output, streamed as the run's page
  streams it today. Nothing about a run changes: its trace, its cost, its budget, its memory and its review are
  what they were, and the exchange shows the cost and links to the trace.
- **The thread holds the loop as well as the talk.** It shows every run of its agent that nobody else started —
  the exchanges, and the pulses, by time. A child run is not a line in the thread; the exchange that started it
  says how many it directed and links to them. The ledger's open decisions sit in the thread, answerable there.
- **Continuity, with provenance (D-78).** The last turns go to the model as *messages*, never as an instruction
  section, capped by turns and by characters, oldest dropped whole. Trust rides along: a reply carried into this
  turn from an externally-tainted run starts this turn externally tainted, as `artifact.read` of a tainted version
  does (RUN-23), so a thread cannot launder a web page into a later turn's trusted memory.
- **The fleet report (D-79).** `GET /api/v1/fleet` — one route, computed, never a model call: for the
  orchestrator and every other agent, its identity and policy, its spend today and this month against its own
  caps (children included, RUN-24), its runs in the window by state with the latest one's summary line, its
  failures and what is running now, what of its needs a person, and its ratings: the orchestrator's estimates
  (count, mean, the latest *why*) and the owner's ratings (count, mean), as two labelled numbers. Counting is done
  in SQL grouped by agent in one pass; `summarizeRun` is called once per agent, for its latest run — never
  `gatherRunFacts` per run, which replays every event list.
- **The board.** `/` after the welcome path, at every width. Across the top, the orchestrator's band: its card
  (spend against its caps, the next pulse), the header — what happened since `last_read_at`, each line a link to
  the screen that holds it — the thread, and the composer. Beneath, a card per agent from the fleet report: a
  state chip, *Lately*, *Spent*, *Rated*; selecting one opens a panel with its last runs (state, cost, summary
  line, a link to each trace), the documents it filed, the decisions it asked, and *Run it* to the existing run
  form at `/agents/:id`, which stays. The Dashboard's *Needs you* content stays on the board, above the fold on
  a phone. Running runs with a Cancel move into the band. The decision card becomes a shared component.
- **The village leaves.** `src/ui/village/`, `src/ui/screens/Village.tsx`, `src/shared/village.ts`, the
  `/village` route, the shell's village branches (the shell returns to the shape at `ec4afe1^`), the sixty
  `--color-village-*` token declarations, `tests/e2e/village.spec.ts`, `tests/unit/village.test.ts`,
  `tests/dod/RUN-19.test.ts`, `docs/village.md`. `FrontDoor` in `App.tsx` sends `/` to the welcome path until it
  is done and to the board after, with no breakpoint. RUN-20 and RUN-22 are withdrawn with it; RUN-21 keeps its
  agent editor. D-71 is superseded, not edited.
- **Routes.** `GET /api/v1/fleet`; `GET /api/v1/conversations`, `POST /api/v1/conversations`,
  `GET /api/v1/conversations/latest?agent=` (the thread to land in, opened the first time),
  `GET /api/v1/conversations/:id`, `POST /api/v1/conversations/:id/messages`, `POST /api/v1/conversations/:id/read`.
  `GET /api/v1/runs` gains `?agent=`. A conversation may only name an agent and a project that exist, and posting
  a message is exactly as permitted as starting that run is.

## Do not

- Do not let any thread text reach an instruction section of any prompt: history is messages, and the `## `
  sections stay the agent's, the owner's page and the project's goals (SEC-47).
- Do not let the thread launder taint: a turn that carries a tainted reply is tainted, and what it then remembers
  is `untrusted` (SEC-47).
- Do not make opening the board, or selecting a card, cost a model call. The report and the header are facts.
- Do not merge the two ratings into one number, or let either choose anything: an estimate is shown as an
  estimate beside the owner's own, and neither reaches the router or the selector (D-06, D-36, D-50).
- Do not call `gatherRunFacts` per agent per run to build the board; count in SQL.
- Do not send the transcript to a delegated child: D-48 is unchanged, a brief is still a brief.
- Do not build a second way to run an agent or a second way to follow one: the composer posts a message, the
  runtime starts the run it always started, and the run page's follower is lifted into a hook both call.
- Do not add a markdown renderer: replies render as documents and outputs do, plain text in a block.
- Do not add threads for every agent in this run. One thread, the orchestrator's; the shape can widen later.

## Definition of done (`npm run dod -- 26`)

1. `GET /fleet` names every agent with its spend against its caps, its window's runs by state and latest summary
   line, and both rating means with the orchestrator's latest *why* — computed from planted rows, matching a
   hand count, with no model call made.
2. `/` after the welcome path is the board, at `md` and below it; `/village` no longer exists, nor does
   `src/ui/village/`, nor any `--color-village-` token.
3. A message posted from the band starts a run in the orchestrator's thread, the reply streams, and the exchange
   shows its cost and a link to its trace.
4. The next message carries the earlier turns to the model as messages, capped, oldest dropped — and no thread
   text appears in any instruction section of the compiled prompt (SEC-47 holds the detail).
5. A pulse run appears in the thread without anyone asking for it, and a delegation does not: the exchange that
   directed it says how many.
6. A decision answered on the board reads back `decided` with the answer, on the Dashboard's card and in the
   band alike.
7. The header names what happened since `last_read_at` with a link for each line; opening the board marks the
   thread read; `dod -- 24` and `-- 23` stay green.
8. e2e `@run-26`: land on the board; two messages with the reply streaming; select an agent's card and read
   its lately, spent and rated panel; answer a decision in the band; the same at phone width with *Needs you*
   above the fold.

**SEC.** New row **SEC-47** (the thread is context with provenance: no thread text in an instruction section;
a tainted reply taints the turn that carries it; a conversation cannot reach an agent or a project the person
could not; the composer grants nothing). `tests/security/sec-47-conversation.test.ts`.

## Amendments this run must make

`decisions.md` (D-77 amended to the band; D-79 the board and the village withdrawn), `data-model.md`
(migration `0015`), `agents-and-prompts.md` (history as messages, and that `promptVersion` does not move for
it), `api-and-cli.md` (`/fleet`, `/conversations/latest`, `?agent=`), `ui.md` (the board as the front door; the
RUN-19 amendment marked withdrawn), `workflows-and-execution.md` (a pulse run joins its agent's thread),
`spec/runs/README.md` (this run's place; RUN-20 and RUN-22 withdrawn; RUN-21 narrowed), `spec/runs/FINISH.md`
(§D struck), `README.md`, `STATUS.md`.

## Human verification

Open the app on the desktop and land on the board. Read the orchestrator's band: what happened since you were
last here. Ask it what the others have been doing; read its answer, then click through to one of the runs it
names. Ask a follow-up that only makes sense if it remembered the first — "and the second one?" — and see that
it does. Select the researcher's card: what it did this week, what it spent, how the orchestrator rated it and how
you did. Turn the pulse on, wait for it, and find its note in the band below your last message. Answer the
decision it leaves without going anywhere else. Open the same workbench on your phone and see the same board,
stacked, with what needs you at the top.
