# The finish list

What stands between the workbench as it is and the workbench as the owner will live in it, in the order it
should be built. Functional first, then the look of the thing, then what is parked on purpose. Each item is a
maintenance branch (`fix/…`, merged on green under the standing authority) or a run brief (`RUN-nn`, with a
decision in `decisions.md`, a DoD and a handoff). The owner strikes items here; nothing below is a promise
until it is.

Written 2026-09-05, after RUN-13 and RUN-14, from what the owner's first days on Windows showed: one key
(Anthropic), no appetite for editing JSON, a monthly ceiling of $100, and a wish for spaces — a project, an
agent, a memory — that stay inside it.

## A. Functional

| # | Item | Why | What | Size | Decision |
|---|---|---|---|---|---|
| F1 | **Model roles, chosen on a screen** | Every shipped agent pins a Gemini id. With only an Anthropic key, every example fails at selection, and the fix today is twelve JSON edits. | An agent's policy may name a *role* — `role:fast`, `role:capable`, `role:cheap` — and Settings gets *Which models do the work*: an ordered pick list per role built from the models that are actually ready. The shipped agents move to roles. A pinned id still wins when written. `doctor` says which roles have no ready model. | M | D-68 |
| F2 | **What a run will cost, before it runs** | The owner asked for token and dollar estimates, and a $100 month is planned per run, not discovered per invoice. | The run form shows an estimate from the compiled prompt's size, the workflow's step count and the chosen models' prices, with the honest caveat (tool loops and outputs are guesses). The Runs list shows cost per run; a run's page shows cost per step. | S | — |
| F3 | **Spend, this month** | The daily cap exists; the month does not. The ceiling the owner set is monthly. | A *Spend* panel on the Dashboard and a `workbench spend` command: today, seven days, thirty days, by model and by agent, with the projection for the month against a new `monthlySpendCapUsd` that pauses scheduled runs when reached. | S | amend D-20 |
| F4 | **Intermediate outputs stay out of Review** | A step filed with `output.document: null` still lands in the queue as unreviewed, so the auditor's JSON sits beside the prose it was never meant to be rated against. | A step whose output is intermediate opens no review row unless it is blocking. The queue shows what a person meant to read. | S | — |
| F5 | **Project spaces** | The owner's vision: a project carries its own agents, tools, memory and goals, so switching projects switches the whole bench. | A project gets a `project.json`: default agents, the tools those agents may use *here* (a further ceiling, never a widening), the memory scopes retrieved, a goals document read into every prompt as a section. The Library shows it; the run form defaults from it; the permissions review reads it. | L | RUN-18 (`RUN-18.md`), D-69 |
| F6 | **A space of the owner's own** | "A space for me: project, agent, memory scope, within budget." Mostly a recipe once F1, F3 and F5 exist. | A shipped `companion` project and agent with its own daily and monthly caps, a `user`-scope memory, the standing instruction to keep notes the owner can read in the Library, and a Welcome step that names it. | S | — |
| F7 | **Story pipeline and friends run on one key** | Follows F1. The examples should run as shipped on whichever key exists. | Re-point every example's step pins to roles; the DoD suites keep pinning exact ids through the mock. | S | — |
| F8 | **Findings on the Dashboard** | The review lands in Review; the Dashboard's *Needs you* should at least count it. | One line under *Needs you*: `3 permission findings`, linking to Review. | S | — |
| F9 | **First hour on Windows** | The README's quick start was written on Linux. The owner's first hour hit `~`, `Path`, Deno and a placeholder path. | A `docs/first-hour-windows.md` that is the owner's transcript, cleaned: install, init, keys, first run, first workflow edit, what each screen is for. Linked from Welcome. | S | — |

## B. The look of it

The rules are in `ui.md` (calm density, one accent, semantic colours for lifecycle only, monospace for prompts
and traces, no decorative motion). What is missing is consistency and a hand: the screens were built one run
at a time.

| # | Item | What | Size |
|---|---|---|---|
| L1 | **A type scale and a spacing scale** | Four text sizes and a spacing rhythm, applied everywhere; today headings and hints vary by screen. | S |
| L2 | **One button family** | `Button` and the link-styled buttons (Workflows, editor) become one component with `asChild`; ghost, secondary and primary used by role, not by mood. | S |
| L3 | **Empty states and first-run states** | Every screen's empty state says what the screen is for and offers the one action that fills it (some do, some say "nothing here"). | S |
| L4 | **The editor on a laptop and a phone** | The graph stacks above the form under `lg`; the step forms collapse to a list of headings with one open. | S |
| L5 | **A mark** | A small wordmark and favicon set, the same in the sidebar, the tab, the phone's Home Screen icon and the notification. | S |
| L6 | **Dark theme pass** | Contrast on badges, cards and the diff view checked in dark; the amber and green tones tuned for it. | S |
| L7 | **Density on the phone** | Review cards, findings and the run form at 390 px: nothing wraps into a column of single words. | S |

## C. Parked on purpose

- **Dogfooding the coding run** on a real model: the owner's call, three to six months out, when models are
  better and cheaper (README amendment, 2026-09-05).
- **Native iPhone app**: a `vision.md` unlock; the web app is installable and pushes.
- **A drag-and-drop workflow editor**: never (D-62).
- **The live verifications** in `STATUS.md`: the owner's, when the owner has time.

## Order

F1 → F7 → F2 → F3 → F4 → F8 → F9 → F6, then L1 → L2 → L3 → L4 → L6 → L7 → L5, then F5 as a run. F1 first
because nothing else is usable on one key without it; F5 last because it is the largest and the one most
worth the owner's eye before it starts.
