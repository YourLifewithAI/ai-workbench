# RUN-26 cross-check — what was claimed, what was reproduced, what was done

The finished build was read by four independent reviewers, each on a slice (the conversation runtime and its trust
rules; the fleet report and routes; the board's UI; the paper, the coverage and the orchestration). Then three
verifiers reproduced or refuted each claim by **running code** (probes against a mock runtime, planted rows, a
driven Chromium), independent of the reviewer who made it. The fixes were made by two implementers with strictly
separate file ownership and by the lead, and each set of fixes was read again by a reviewer who had not written
it. The first verification pass was killed by the account's usage limit before it saved anything; it was rerun
with each verdict written to a file as it was reached. The verifiers' evidence is not in the repository; every
fix below has a test in it that fails without the fix.

Statuses: **fixed**, **known gap** (stated, not fixed), **by design** (a decision, recorded), **open** (needs the
owner).

## The conversation runtime and its trust rules

| Claim (confirmed by running code unless noted) | Status |
|---|---|
| A resumed exchange lost the thread's history and its taint tracker: after a resume that read the web the next turn wrote *trusted* memory; the D-29 approval did not fire after a resume. The taint half was already on `main` for every resumed agent run; the history half was this branch's | **fixed** (one shared helper; three tests fail on the old code) |
| Private taint did not ride the thread | **fixed** |
| One oversized newest pair made `history()` return nothing (a wall until it aged out of the window) | **fixed**: the newest pair is always kept, clipped; older pairs stay whole while they fit |
| The trace did not name the turn that tainted a turn (D-78 said it did) | **fixed**: `run-started.thread { carried, taintedFrom, privateFrom }`, descriptors only, asserted to carry no message text |
| No tie-break on equal timestamps (0% wrong on a disk temp directory, 82% on `/dev/shm`, 95% in memory) | **fixed** (`rowid`) |
| A delegated child could in principle be handed a conversation | **fixed**: starting a run that is both is refused |
| A second message posted while the first was being answered ran blind to the first | **fixed**: `409` while a run of that thread is queued or running |
| A whitespace-only message was accepted | **fixed** (trimmed; zero-width characters are not stripped: known gap) |
| Taint is sticky: one web read taints every later turn of the thread (a chain of twelve) | **by design** (D-78, SEC-47), and the way out now exists: *New conversation* on the board. A privately-tainted reply is carried the same way |
| The thread lists the newest 100 runs, so pulses crowd out exchanges after some days | **known gap** |
| Tainted replies go to the model as role `assistant` | **by design**; fencing them is a later question |
| Failure-reason helper: a cut could split an emoji, an over-eager stack filter, credential shapes it missed | **fixed** |

## The fleet report and the header

| Claim | Status |
|---|---|
| Ratings, estimates and what waits on you were keyed on `runs.agent_id`, NULL for workflow runs: a `story-pipeline` rating never reached its agent, and the pulse's decisions never reached the companion | **fixed**: through the step, then the workflow's sole step agent |
| `run_steps.cost_usd` is always 0; never-started steps counted as activity | **fixed**: cost, calls and tokens from `model_calls`; only started steps count |
| Card cost came from `spent_json` (children and detached reservations included) while tokens came from calls: off by up to 10× | **fixed** |
| `since` was compared as a string ("Sep 27 2026", a future date, an offset all wrong) | **fixed** (normalised) |
| The owner's mean included Compare picks and counted rows; an agent run's `rating` and `rating:main` counted twice | **fixed** |
| The header capped at 200 runs, counted a waited child's spend twice, left `waiting_approval` out of running | **fixed**: counted in SQL over top-level runs |
| A child the parent let go and that failed overnight never reached the header | **fixed**: children that outlived their parent count |
| The header's money line printed all spend as if it belonged to the finished runs | **fixed**: its own line |
| A step parked on an approval made the card read *running* | **fixed** |
| `GET /fleet` costs about 0.8 s at 10,000 runs (two recursive spend queries per agent, inherited from RUN-24's `GET /agents`); about 125 ms at a realistic size | **known gap**; three indexes added (about 66 ms at a realistic size); one grouped spend query is the follow-up |
| The window has no bucket for cancelled or waiting runs; `running` is "right now" whatever the window | **known gap** |
| A whole-run estimate on a single-agent workflow lands on nobody; a workflow-only agent whose step failed reads *idle* | **known gap** |
| `runs.facts` compares `since` as text (the same class, outside this diff) | **known gap** |
| A dev database that already applied the earlier `0015` lacks the three indexes | **known gap** (no such database is shipped) |

## The board

| Claim | Status |
|---|---|
| The composer stayed disabled forever if the live streams died (a locked phone) | **fixed**: the thread is polled while an answer is pending; browser test |
| "Since you were last here" was stale after leaving and returning, and marked read again | **fixed** (a fresh load only) |
| After Ctrl+Enter focus was lost and `a` **allowed a permission** | **fixed**: read-only, not disabled; browser test |
| Two quick sends started two runs and wiped typed text | **fixed** |
| Answering one copy of a decision left the other answerable and the fleet card stale | **fixed**; browser test |
| `#needs-you` links scrolled nowhere | **fixed** |
| Long words in decisions overflowed a phone | **fixed** (`wrap-anywhere`) |
| Link targets were 28 px | **fixed** |
| The reply `<pre>` failed axe's scrollable-region rule | **fixed** (the thread scrolls, and takes focus) |
| A failed exchange said only "(the run failed)"; a failing `conversations/latest` showed "Reading the room…" forever | **fixed** (a reason, an alert) |
| Focus lost after send; a keyboard hint on phones; first-visit wording | **fixed** |
| The screen reader heard every chunk twice; the closing line said *answered* for a failed run | **fixed** |
| The header's needs-you counts contradicted the live section beneath | **fixed** (live counts) |
| A pulse note from a tainted run was unmarked | **fixed** |
| A new conversation still showed every old pulse | **fixed**: it begins where it was started |
| Scroll-to-bottom on every streamed chunk pulls a reader down | **known gap** |

## The paper and the orchestration

| Claim | Status |
|---|---|
| Welcome opened the run form; the RUN-19 amendment was not marked withdrawn; D-71 had no pointer; the Dashboard row; a wrong commit for the pre-village shell; dead `media.ts`; stale caps in two docs | **fixed** |
| The companion's instructions said nothing about the thread being plain text or how to answer "what have the others been doing?" | **fixed** |
| *Rated* never said *estimate* or the scale | **fixed** ("orchestrator's estimate 3.5/5 (4 rated) · you 4.0/5 (2 rated)") |
| The brief promises children links, per-run summary lines, filed documents and decisions asked in a card's panel; the build ships a directed-run count as text, the last ten runs with a trace link, and needs-you counts | **open**: the owner's call to narrow the brief or ask for the rest; not narrowed silently |
| Placeholders in the runlog and STATUS | **fixed** at the final gate |
