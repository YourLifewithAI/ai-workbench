# RUN-26 — The room where you talk

*Written 2026-09-12, from the owner's own words after he started the workbench and could not find the
orchestrator: "Where do we go to discuss things with the orchestrator? I don't see anywhere in the UI interface
by which I would strike up a conversation with the orchestrator, let alone have it report back to me letting me
know what the various agents have been doing. … a lot of this should be coming from the orchestrator. Or at the
very least the orchestrator could point me towards where I should go to check on progress."*

**Goal.** The one agent he actually talks to gets a place to talk. A thread he types into, where each exchange
is a real run underneath, where the pulse's notes and the decisions it asks for arrive in the same stream, and
which opens by saying what has happened since he was last here and where to go for each of it. The village gave
every function a house and gave the orchestrator none; this is that house, and it is the front door.

**Reads.** D-12, D-17, D-46, D-48, D-58, D-71, D-73, D-74, D-75, D-76, D-77, D-78; `spec/runs/RUN-23.md` and
`RUN-24.md`; `runlog/RUN-24.md` (*Notes for the next run*); `src/runtime/engine/prompt.ts` (assembly and
`promptVersion`), `step.ts` (`profileFor`, `scopesFor`), `run.ts` (`startAgentRun`, `runFacts`, the taint
loader); `src/runtime/work/store.ts`; `src/runtime/orchestrator/facts.ts`; `src/ui/screens/Dashboard.tsx` (the
decision card), `Agents.tsx` (the run form and its streaming), `src/ui/village/` and `village.json`;
`src/ui/screens/FrontDoor.tsx`.

## What is wrong today

The companion is reachable at Agents → Companion, where a run form takes one message and answers it. Three
things are missing and the owner named all three:

- **No conversation.** Every exchange is its own run on its own page. There is no thread to scroll back through,
  and the agent carries nothing of the last exchange but what memory retrieval happens to return.
- **No orchestrator-authored home.** The Dashboard is assembled by the interface from database queries. The
  orchestrator wrote none of it and has nowhere to greet him or say what happened.
- **No hand-off.** Nothing points anywhere. Twelve buildings, and the visitor guesses which one holds the thing
  he wanted.

RUN-24 made the orchestrator report — the pulse's note, the ledger, a decision as options — but it reports to a
noticeboard. This run makes it a conversation.

## Scope

- **A conversation is a thread of runs (D-77).** `conversations(id, title, agent_id, project, created_at,
  updated_at, last_read_at)` and `runs.conversation_id` (migration `0015`). Posting a message starts an agent run
  in the thread; the reply is that run's output, streamed as the Agents screen streams it today. Nothing about a
  run changes: its trace, its cost, its budget, its memory and its review are what they were, and the exchange
  shows the cost and links to the trace.
- **The thread holds the loop as well as the talk.** It shows every run of its agent that nobody else started —
  the exchanges, and the pulses, by time. A child run (a delegation, a workflow) is not a line in the thread; the
  exchange that started it says how many it directed and links to them. Decisions and work items the run filed
  appear where they were filed.
- **Continuity, with provenance (D-78).** The last turns go to the model as *messages*, never as an instruction
  section: the owner's turns as his, the agent's replies as its own. History is capped by turns and by characters,
  oldest dropped. Trust rides along: if a reply carried into this turn came from an externally-tainted run, this
  run starts externally tainted, exactly as `artifact.read` of a tainted version does (RUN-23). So a thread cannot
  launder a web page into a later turn's trusted memory, and the trace says which turn did it.
- **Leading with the state.** The room's header is computed, not written: since `last_read_at` — runs finished,
  what they cost, what needs you, what is in flight — each line a link to the screen that holds it. It costs no
  model call, so opening the room is free; the orchestrator's own words in the thread are the pulse's, already
  paid for. Opening the room marks it read.
- **Answerable inline.** The decision card from the Dashboard becomes a shared component and appears in the
  thread; answering it there is the same `PUT /work/:id`, and the next pulse reads the answer.
- **The house, and the front door.** A building in `village.json` for the room, and after the welcome path the
  room is where the app opens, on a desktop and on a phone. The village is one click from it and stays in the
  sidebar: this changes which door is first, not what the village is (D-71 stands).
- **Routes.** `GET /api/v1/conversations`, `POST /api/v1/conversations`, `GET /api/v1/conversations/:id` (the
  thread and the header), `POST /api/v1/conversations/:id/messages` (starts the run, 202 with its id),
  `POST /api/v1/conversations/:id/read`. A conversation may only name an agent that exists and a project that
  exists, and starting a message is exactly as permitted as starting that run is.

## Do not

- Do not let any thread text reach an instruction section of any prompt: history is messages, and the `## `
  sections stay the agent's, the owner's page and the project's goals (SEC-47).
- Do not let the thread launder taint: a turn that carries a tainted reply is tainted, and what it then remembers
  is `untrusted` (SEC-47).
- Do not make opening the room cost a model call, ever. The header is facts.
- Do not send the transcript to a delegated child: D-48 is unchanged, a brief is still a brief.
- Do not build a second way to run an agent. The composer posts a message; the runtime starts the run it always
  started.
- Do not add threads for every agent in this run. One room, the orchestrator's; the shape can widen later.

## Definition of done (`npm run dod -- 26`)

1. A message posted to a thread starts a run in it, the reply streams, and the exchange shows its cost and a link
   to its trace.
2. The next message carries the earlier turns to the model as messages, capped, oldest dropped — and no thread
   text appears in any instruction section of the compiled prompt.
3. A reply from an externally-tainted run, carried into the next turn, marks that turn's run externally tainted,
   and memory it writes is `untrusted`; a clean thread stays trusted.
4. A pulse run appears in the thread without anyone asking for it, and a delegation does not: the exchange that
   directed it says how many and links to them.
5. A decision is answered inside the thread; `work.list` then returns it `decided` with the answer.
6. The header names what happened since `last_read_at` with a link for each line, opening the room marks it read,
   and no model call is made by opening it.
7. The room is the front door after the welcome path, on a desktop and below `md`; the village is one click away
   and its own house links to the room.
8. e2e `@run-26`: a conversation held in the browser — two messages, the reply streaming, a decision answered in
   the thread, the header's link followed.

**SEC.** New row **SEC-47** (the thread is context with provenance: no thread text in an instruction section;
a tainted reply taints the turn that carries it; a conversation cannot reach an agent or a project the person
could not; the composer grants nothing). `tests/security/sec-47-conversation.test.ts`.

## Amendments this run must make

`data-model.md` (migration `0015`), `agents-and-prompts.md` (history as messages, and what `promptVersion`
covers), `api-and-cli.md` (five routes), `ui.md` (the room, the front door), `workflows-and-execution.md` (a
pulse run joins its agent's thread), `spec/runs/README.md` (this run's place in the order).

## Human verification

Open the app. The room is what you land in, and the first thing it says is what happened since you were last
here. Ask it what the village has been doing; read its answer, then click through to one of the runs it names.
Ask a follow-up that only makes sense if it remembered the first — "and the second one?" — and see that it does.
Turn the pulse on, wait for it, and find its note in the same thread, below your last message. Answer the
decision it leaves without going anywhere else.
