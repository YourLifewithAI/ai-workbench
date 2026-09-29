# RUN-26 cross-check — findings and what became of them

Four read-only reviewers each read a slice of the finished build (runtime and taint; the fleet report and routes;
the board's UI; the paper, coverage and orchestration). A second wave was to reproduce or refute each claim by
running code. That wave was cut off by the account's usage limit and is being rerun, so **every line below is a
reviewer's claim until its status says otherwise.** Statuses: `open` (unverified), `fixed`, `known gap` (stated
in `runlog/RUN-26.md`), `refuted`.

## Runtime and taint (R1)
| # | Claim | Status |
|---|---|---|
| R1-1 | `resumeAgentRun` passes no `taint` and no `history`: a resumed conversation exchange that then reads the web keeps `external_tainted = 0`, and the next turn carries its reply as clean (SEC-47) | open |
| R1-2 | One oversized newest pair breaks `history()` out of its loop and drops all carried context | open |
| R1-3 | D-78 says the trace names the turn that tainted it; `markExternal` discards its reason and no event records it | open |
| R1-4 | A reply from a privately-tainted run does not mark the next turn private (D-29) | open |
| R1-5 | `ORDER BY updated_at DESC` has no tie-break: wrong thread on a same-millisecond tie; `conversation-store.test.ts` can flake | open |
| R1-6 | D-48 holds by convention, not by a guard on `input.parent`; no test that a child gets no thread text | open |
| R1-7..10 | `thread()` takes the newest 100 runs (pulses crowd out chat); history snapshotted at post time; whitespace-only API message; tainted replies sent as role `assistant` | open |

## Fleet report and routes (R2, R4)
| # | Claim | Status |
|---|---|---|
| R2-1 / R4-2 | Ratings, estimates and `needsYou` key on `runs.agent_id`, which is NULL for workflow runs: workflow-step ratings never reach a card, and the pulse's decisions never mark the companion as needing you | open |
| R2-2 | `run_steps.cost_usd` is always 0; pending (never-run) steps count as activity | open |
| R2-3 | window cost/calls come from `runs.spent_json` (includes children, reservations); tokens from `model_calls`; windows disagree | open |
| R2-4 | `since` is validated with `Date.parse` but compared as a string | open |
| R2-5 | owner mean includes Compare picks (5 / 1); `count` counts rows | open |
| R2-6 | tokens are computed but never shown on a card (the owner asked for token spend) | open |
| R2-7 / R4-3 | `threadHeader` caps at 200 runs, double-counts a waited child's spend, omits `waiting_approval` from running | open |
| R2-8 | `/fleet` synchronous cost at scale (two recursive CTEs per agent); about 620 ms at 10,000 runs per R2's probe | open |

## Board UI (R3, R4)
| # | Claim | Status |
|---|---|---|
| R3-1 | no error shown for a failed answer or a failed `conversations/latest` | open |
| R3-2 | answering on the Needs-you card leaves the thread's copy answerable; the band's handler does not invalidate `fleet` | open |
| R3-3 | `<Link to="#needs-you">` does not scroll under `BrowserRouter` | open |
| R3-4 | composer can stay disabled forever if the live streams die (iPhone lock screen) | open |
| R3-5 | double Ctrl+Enter before the 202 starts two runs | open |
| R3-6 / R4-4 | "Since you were last here" is stale after a remount within cache time | open |
| R3-7 | `aria-live` on streaming chunks inside `role=log` announces twice | open |
| R3-8 | after Ctrl+Enter focus is lost and `a` / `d` act on a pending approval | open |
| R3-9..17 | scrollable `pre` not focusable; tainted pulse unmarked; 14 px textarea zooms iOS; "orchestrator 3.5 over 4" reads as x/4 and never says *estimate*; long words overflow; 28 px link targets; copy states; duplicated constants | open |

## Paper and orchestration (R4)
| # | Claim | Status |
|---|---|---|
| R4-1 | runlog and STATUS placeholders | open (filled at the final gate) |
| R4-5 | a failed exchange shows only "(the run failed)"; no reason | open |
| R4-6 | companion instructions: `## notes` restates each reply; nothing says the thread is plain text or how to answer "what have the others been doing?" | open |
| R4-7 | *Rated* never says *estimate* (brief "Do not", ui.md rule 2) | open |
| R4-8 | the brief promises children links, per-run summary lines, filed documents and decisions asked in a card's panel; the build ships fewer (a directed-run count as text; last runs with a trace link; needs-you counts) | open: build it, or the owner narrows the brief; not to be narrowed silently |
| R4-9 | Welcome step 5 opens the run form | fixed |
| R4-10 | RUN-19 amendment not marked withdrawn; Dashboard row; D-71 pointer | fixed |
| R4-11 | brief and runlog cite the wrong commit for the pre-village shell | fixed (`ec4afe1^`) |
| R4-13 | dead `media.ts` | fixed (removed) |
