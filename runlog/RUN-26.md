# RUN-26 handoff — The board

**Branch:** `run/26-room` · **Head:** HEAD_PLACEHOLDER · **Status:** awaiting verification

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

## Not built (deliberate)
- Threads for other agents: one thread, the orchestrator's; the store and the routes take any agent, the board opens only the companion's.
- Renaming or listing threads on a screen: `GET /conversations` and `rename` exist for the day the shape widens.
- A markdown renderer: replies render as documents and outputs do, plain text in a block.
- `memory.curate`, `memory.facts`, `project.create`, cases from runs, the `human` evaluator, "agrees with you N of M" — RUN-25.

## Deviations from the brief
- The brief was rewritten mid-run, from the owner's words: the first draft put the room in a house in the village; the owner withdrew the village and asked for a board. Steps 2 and 3 (the store, history as messages, SEC-47) shipped as first drafted; the house became the band.
- The decision card is drawn in two places on the board — under *Needs you* and in the thread — and is one component with two test ids (`decision-<id>`, `thread-decision-<id>`); the pulse's browser case keeps its locator.
- A card's title is the agent's name alone; its state is a chip beside the heading, not inside it, so "needs you" on a card is never a heading that says *Needs you*.
- *Since you were last here* is held from the first load of a visit and the thread is marked read once; later refetches bring new entries, not a new header.

## Verification transcript
```
$ npm run check
TRANSCRIPT_CHECK
$ npm run build && npx vitest run --project dod
TRANSCRIPT_DOD
$ WB_CHROME=/opt/pw-browsers/chromium npx playwright test --workers=1
TRANSCRIPT_E2E
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 26
TRANSCRIPT_DOD26
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 24
TRANSCRIPT_DOD24
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 23
TRANSCRIPT_DOD23
$ npm run dod -- 19
dod: no suite at tests/dod/RUN-19.test.ts   (exit 2 — the village's suite left with it)
```
The DoD suites must run against a fresh `dist/` (`npm run build` first, or `npm run dod -- NN`, which builds): a
`dist/` from before migration 0015 refuses a workspace the source runtime has migrated to 15.

## SEC tests added
- SEC-47 → `tests/security/sec-47-conversation.test.ts`

## Spec amendments made
- `spec/decisions.md` D-77 (amended to the band), D-79 · `spec/sec-catalog.md` SEC-47 · `spec/runs/README.md` (RUN-26's place; the redirect; RUN-20 and RUN-22 withdrawn, RUN-21 narrowed) · `spec/runs/FINISH.md` §D withdrawn · `spec/runs/RUN-26.md`
- `spec/data-model.md` (0015) · `spec/agents-and-prompts.md` (history as messages; `promptVersion` unmoved) · `spec/api-and-cli.md` ×2 (the room's routes; `/fleet`, `/conversations/latest`, `?agent=`) · `spec/ui.md` (the board as the front door; the RUN-19 amendment withdrawn) · `spec/workflows-and-execution.md` (a pulse joins its agent's thread) · `README.md` · `STATUS.md`

## Known gaps
- The header counts every run in the workspace since the thread was last read, not only the orchestrator's: it is "what happened while you were away", and the workbench has one owner.
- A reply's streaming text is deltas, live only, as on the run's page: a follower that subscribes after a chunk has gone misses that chunk until the reply is written. The composer subscribes the moment the message is accepted; on the mock, whose first chunk is out before the 202, the arriving text starts at the second chunk, and the exchange settles on the reply as written. A real model's first token takes longer than the subscription does. Replaying a step's partial text to a late subscriber would close it, for the run's page too.
- On the mock the companion's runs cost nothing, so an exchange reads $0.00 until a real model runs; the fleet DoD plants rows to prove the counting.
- `GET /fleet` runs six grouped queries and one summary per agent; measured on a workspace of 200 runs at 14 agents it is under 20 ms. The `GET /agents` N+1 from RUN-24's notes still stands beneath it, since the report takes the agents' summaries as given.

## Notes for the next run
- `useRunStream(id, keys)` is the one follower: it invalidates `['run', id]` and each key on a terminal event. A new live view names its query key rather than subscribing again.
- A decision entry in the thread is the open item itself (`needs-you`); once answered it leaves the thread and the card together, and the ledger shows it `decided` until the pulse marks it done.
- The mock's `chunkDelayMs` is what makes a reply watchable in a test; a fixture without it answers before a follower can subscribe.
- `DecisionCard` takes `testId` for a second copy on one screen; the default is the Dashboard's.

## Human verification script
1. Start the workbench and open it: the board. Read *Since you were last here*, and click one line through to where it points.
2. In the band, ask the orchestrator what the others have been doing. Read its answer; click *its trace* on the exchange and see an ordinary run. Back on the board, ask "and the second one?" — it should know what you meant.
3. Select the researcher's card: *Lately*, *Spent* against nothing, *Rated* as the orchestrator's number and yours. *Details*: its last runs with a *trace* each; *Run it* is the form you always had.
4. Workflows → The pulse → enable; two hours on, the pulse's note is in the band under your last message, with what it filed. Answer the decision it leaves without leaving the board; *Needs you* and the band both let it go.
5. Open the same workbench on your phone: the board, stacked, the band first and what needs you above the fold; the tab bar beneath.
6. Nothing at `/village`: "Not found".
