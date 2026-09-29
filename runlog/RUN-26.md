# RUN-26 handoff — The board

**Branch:** `run/26-room` · **Head:** `2c6899b` · **Status:** awaiting verification

## Built
- `src/runtime/db/migrations/0015_conversations.sql` — `conversations`; `runs.conversation_id` and its index; `runs_agent_idx` for the board's counting.
- `src/runtime/conversations/store.ts` — `ConversationStore`: `create`, `get`, `list`, `latestOrCreate`, `touch` (titles a thread from its first message), `rename`, `markRead`, `thread` (the conversation's own runs and every workflow run with a step of its agent that nobody's message started — the pulses — as `exchange` and `pulse` entries with cost, children directed and what was filed, plus the open decisions, by time), `history` (the last completed pairs, capped by turns and by characters, oldest dropped whole, each reply with its run's taint).
- `src/runtime/engine/run.ts` — `conversations` on the engine; `StartAgentRunInput.conversation`; the row carries `conversation_id`; the thread's history goes to the step as messages and a tainted carried reply marks the turn external (D-78); `listRuns` takes `agent`; `fleet()` wires the report. `src/runtime/engine/step.ts` — `history` prepended to the transcript, observed by the taint tracker. `src/shared/workspace.ts` — `context.conversationTurns` (8) and `conversationChars` (12,000).
- `src/runtime/orchestrator/fleet.ts` — `fleetReport`: six grouped queries (runs by state from `spent_json`, steps from `run_steps`, tokens from `model_calls`, what is running, the orchestrator's estimates, the owner's ratings) and one `summarizeRun` per agent for its latest run; `ORCHESTRATOR_AGENT`; the default window seven days.
- `src/runtime/api/app.ts` — `GET /fleet` (`?since=`), `GET /conversations/latest?agent=`, `GET`/`POST /conversations`, `GET /conversations/:id` (entries and a computed `header`), `POST /conversations/:id/messages` (202, the agent run it always started), `POST /conversations/:id/read`; `GET /runs?agent=`.
- `src/shared/api/index.ts` — `ConversationSummary`, `ThreadEntry`, `ThreadHeader`, `ConversationResponse`, `CreateConversationRequest`, `PostMessageRequest`, `RatingAggregate`, `AgentReport`, `FleetResponse`.
- The board: `src/ui/screens/Dashboard.tsx` recomposed — `src/ui/components/OrchestratorBand.tsx` (the card, *Since you were last here* with a link a line, *Needs you* and *Running* inside it, the thread, the composer; the reply streams through `src/ui/lib/useRunStream.ts`, the run page's follower lifted into one hook both call), `src/ui/components/AgentCards.tsx` (a card per agent: state chip, *Lately*, *Spent*, *Rated* as two labelled numbers, *Pulse*; *Details* opens onto the last ten runs and *Run it*), `src/ui/components/DecisionCard.tsx` (`DecisionCard` and `WorkRow` shared), `src/ui/lib/agentLines.ts` (`spentLine`, `heartbeatLine`, `money`), `src/ui/lib/api.ts` (`fleet`, `runsFor`, `conversationLatest`, `conversation`, `postMessage`, `markRead`).
- The village withdrawn (D-79): `src/ui/village/` (ten files), `src/ui/screens/Village.tsx`, `src/shared/village.ts`, `docs/village.md`, `tests/e2e/village.spec.ts`, `tests/unit/village.test.ts`, `tests/dod/RUN-19.test.ts` deleted; `src/ui/components/Shell.tsx` back to the shape at `ec4afe1^`; `src/ui/App.tsx` — no `/village`, and `/` goes to the Dashboard after the welcome path at every width; the sixty `--color-village-*` declarations gone from `src/ui/styles.css`. The companion's description calls it the orchestrator of the others; its *the village* instruction section keeps its name.
- Tests: `tests/unit/conversation-store.test.ts` (6), `tests/unit/fleet.test.ts` (4), `tests/security/sec-47-conversation.test.ts` (7), `tests/dod/RUN-26.test.ts` (8: the fleet report against a hand count with no model call; the village gone from the tree and the build; a message is a run in the thread and its reply streams; the earlier turns as messages and none in the system string; a pulse in the thread and a delegation not; a decision answered reads back decided on the card and in the band; the header counts from the read), `tests/e2e/dashboard.spec.ts` (4, `@run-26`) and the front-door case in `tests/e2e/phone.spec.ts` (retagged from `@run-19`).
- What the cross-check added (see `runlog/RUN-26-crosscheck.md` for every claim and its disposition): resume carries the thread, its taint and its private mark (one helper, `Engine.historyFor`); the newest pair of a thread is always kept, clipped; the trace's `run-started` names the turns a turn carried (`thread { carried, taintedFrom, privateFrom }`, descriptors only); `409` while a run of the thread is queued or running; a failed exchange says why in a redacted line; a pulse entry says whether it read outside; the fleet report follows a workflow step to its agent and takes cost, calls and tokens from `model_calls`; the header is counted in SQL over top-level runs and the children that outlived their parent; three indexes on migration `0015`; *New conversation* on the board (a fresh thread shows only the pulses since it began).

## Not built (deliberate)
- Threads for other agents: one thread, the orchestrator's; the store and the routes take any agent, the board opens only the companion's.
- Renaming or listing threads on a screen: `GET /conversations` and `rename` exist for the day the shape widens.
- A markdown renderer: replies render as documents and outputs do, plain text in a block.
- `memory.curate`, `memory.facts`, `project.create`, cases from runs, the `human` evaluator, "agrees with you N of M" — RUN-25.

## Deviations from the brief
- The brief was rewritten mid-run, from the owner's words: the first draft put the room in a house in the village; the owner withdrew the village and asked for a board. Steps 2 and 3 (the store, history as messages, SEC-47) shipped as first drafted; the house became the band.
- **A card's panel is narrower than the brief says. This is the owner's call and is open.** The brief promises, per card, a summary line for each run, the documents the agent filed, the decisions it asked, and links to the runs an exchange directed. The build ships the last ten runs (state, when, cost, project, a *trace* link), the latest run's lines, the two ratings' last words, what of its needs you as counts, and *Run it*; an exchange says how many runs it directed as text. Not narrowed silently: say which of the rest you want.
- **`New conversation` is beyond the brief.** D-78 makes a thread's taint sticky (one web read taints every later turn), the docs said a person starts a fresh thread, and no control did; the companion routinely reads the web through the researcher, so the owner's one thread would have stayed tainted for good. The button, and a fresh thread showing only the pulses since it began, close that.
- The decision card is drawn in two places on the board — under *Needs you* and in the thread — and is one component with two test ids (`decision-<id>`, `thread-decision-<id>`); the pulse's browser case keeps its locator.
- A card's title is the agent's name alone, the state a chip beside it, so no card heading reads as "Needs you".
- *Since you were last here* holds its runs, spend and running counts from the first fresh load of a visit, and takes the counts of what needs you live from the board, so the header never contradicts the section under it.
- The header counts top-level runs and the children that outlived their parent, not every run: a child a parent waited for is inside its parent.
- Two Windows-only CI failures on the way, both in tests: the RUN-23 owner-page case raced the refetch that re-creates its form (fixed by waiting for the new form); and the two new unit files built a file database per test, which timed out their hooks on the runner (fixed: in memory, one transaction).

## Verification transcript
```
$ npm run check
unit 182 · security 205 · contract 52 · route-drift clean (97) · secret-scan clean
$ npm run build && npx vitest run --project dod
22 files, 154 passed, 2 skipped (live-only)
$ WB_CHROME=/opt/pw-browsers/chromium npx playwright test --workers=1
58 passed (the last full run had 57 passed and one failing assertion in a new test, corrected; the nine @run-26 cases were then re-run: 9 passed)
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 26
Tests 12 passed (12); @run-26 e2e 9 passed
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 24
Tests 5 passed (5); @run-24 e2e 2 passed
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 23
Tests 6 passed (6); @run-23 e2e 3 passed
$ npm run dod -- 19
dod: no suite at tests/dod/RUN-19.test.ts   (exit 2 — the village's suite left with it)
```
CI on the pushed head before this commit (`86637b7`): check (ubuntu-latest), check (windows-latest), docker, no-sandbox and timezone all green.
The DoD suites must run against a fresh `dist/` (`npm run build` first, or `npm run dod -- NN`, which builds): a `dist/` from before migration 0015 refuses a workspace the source runtime has migrated to 15.

## SEC tests added
- SEC-47 → `tests/security/sec-47-conversation.test.ts` (15: what was said is context, never an instruction; the caps; a child is briefed and never handed the transcript; a thread carries trust, external and private, and a resumed turn carries it too; a room reaches no further than a run form)

## Spec amendments made
- `spec/decisions.md` D-77 (amended to the band), D-79 · `spec/sec-catalog.md` SEC-47 · `spec/runs/README.md` (RUN-26's place; the redirect; RUN-20 and RUN-22 withdrawn, RUN-21 narrowed) · `spec/runs/FINISH.md` §D withdrawn · `spec/runs/RUN-26.md`
- `spec/data-model.md` (0015) · `spec/agents-and-prompts.md` (history as messages; `promptVersion` unmoved) · `spec/api-and-cli.md` ×2 (the room's routes; `/fleet`, `/conversations/latest`, `?agent=`) · `spec/ui.md` (the board as the front door; the RUN-19 amendment withdrawn) · `spec/workflows-and-execution.md` (a pulse joins its agent's thread) · `README.md` · `STATUS.md`

## Known gaps
- `GET /fleet` (and `GET /agents`, which it shares) computes each agent's spend with two recursive queries: about 125 ms at a realistic size (a few thousand runs) and about 800 ms at 10,000 runs and 100,000 calls, all of it synchronous. Three indexes cut the realistic case to about 66 ms; one grouped spend query is the follow-up.
- The thread lists the newest 100 runs and has no paging: with a two-hourly pulse, older exchanges scroll out of view after some days.
- The fleet window has no bucket for cancelled or waiting runs, and `running` means right now whatever the window; a whole-run estimate on a single-agent workflow lands on nobody; a workflow-only agent whose step failed reads *idle*; `run_steps.cost_usd` is still hard-coded to 0 (the report bypasses it).
- Taint is sticky by design (D-78): a thread that once carried the web carries it to the end. *New conversation* is the way out.
- `runs.facts` compares `since` as text, the same class as the fleet bug, in a tool outside this run.
- On the mock the companion's runs cost nothing, so an exchange reads $0.00 until a real model runs; the DoD plants rows to prove the counting.
- A reply's streaming text is deltas, live only, as on the run's page: a follower that subscribes after a chunk has gone misses that chunk until the reply is written. On the mock, whose first chunk is out before the 202, the arriving text starts at the second chunk; a real model's first token takes longer than the subscription does.
- A database that already applied the earlier `0015` lacks its three indexes (none is shipped).
- Not fixed, minor: zero-width characters are not trimmed from a message; a clip at a budget under about 20 characters returns 20; the thread scrolls to the bottom on every streamed chunk.

## Notes for the next run
- `useRunStream(id, keys)` is the one follower: it invalidates `['run', id]` and each key on a terminal event. The band also polls its thread while an answer is pending, because a phone that locked its screen has lost its streams; the thread is the truth about whether a run finished.
- `Engine.historyFor(conversationId, taint, before?)` is the one place a turn's thread is worked out and its trust marked; start and resume both call it. Anything new that puts thread text in front of a model goes through it.
- A conversation's thread shows every pulse of its agent if it is the agent's first conversation, and only the pulses since it began if it is a later one.
- The mock's `chunkDelayMs` is what makes a reply watchable in a test; a fixture without it answers before a follower can subscribe. A browser test's message must not match a shipped companion fixture that calls a tool (`companion-remember`), or a memory item is written that a later spec's echo run retrieves and its trace gains an event.
- Unit tests that build a database from the migrations use `:memory:` and one transaction; a file database per test times out the hook on the Windows runner.
- `DecisionCard` takes `testId` for a second copy on one screen; the default is the Dashboard's.

## Human verification script
1. Start the workbench and open it: the board. Read *Since you were last here*, and click one line through to where it points.
2. In the band, ask the orchestrator what the others have been doing. Read its answer; click *its trace* on the exchange and see an ordinary run. Back on the board, ask "and the second one?" — it should know what you meant.
3. Select the researcher's card: *Lately*, *Spent* against nothing, *Rated* as the orchestrator's number and yours. *Details*: its last runs with a *trace* each; *Run it* is the form you always had.
4. Workflows → The pulse → enable; two hours on, the pulse's note is in the band under your last message, with what it filed. Answer the decision it leaves without leaving the board; *Needs you* and the band both let it go.
5. Open the same workbench on your phone: the board, stacked, the band first and what needs you above the fold; the tab bar beneath.
6. Nothing at `/village`: "Not found".
7. Ask it to look something up on the web through the researcher, then say something else. A line under *The conversation* says something read from outside is carried through it. Press *New conversation*: the thread is empty, the line is gone, and what it remembers next is yours again.
8. While it is answering, lock your phone for a minute and unlock it: the composer comes back and the answer is there. Answer a decision on either copy: the other copy goes with it.
