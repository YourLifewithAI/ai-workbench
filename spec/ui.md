# UI

*Prose cap: 1000 words. Decisions cited: D-13, D-22, D-43, D-56 … D-59. Evidence in `research.md` §UI.*

The UI is the owner's control surface, not the product. It must let a verifier and tastemaker see what ran, what it cost, what it produced, what it asked permission for, and where the work is — without reading a trace file — and it must be pleasant to live in for someone who opens it many times a day. Everything it shows, the CLI can also show.

## Friendly by design (D-56 … D-59)

"Friendly" here is not decoration. It is the set of properties that make an owner trust the system correctly, act quickly, and never feel stupid. Each maps to evidence:

1. **The first run is a guided path** (D-56): choose a workspace → add a provider key, or pick *offline with local models* or *try it with the mock* → run the example → read its trace. Four screens, each one action, each with a "why" line. Every empty list is an empty state that says what will appear there and offers the one action that fills it. (Nielsen: recognition over recall; progressive disclosure.)
2. **Make clear what it can do and how well** (Amershi G1, G2): the Models screen shows capabilities and data policy; every judge score says *estimate*; every cost says *stored* or *estimate*; the harness never claims a capability it lacks.
3. **Answer "what needs me?" first** (G4): the Dashboard's top block is *Needs you* — approvals, blocking reviews, failures — then *Running* with budget bars, then *Today* (spend vs cap, next scheduled). Nothing else competes above the fold.
4. **Approvals designed against fatigue** (D-57): an approval card leads with a one-line risk summary in plain words ("wants to POST 2 KB of text to api.example.com; this run has read your project documents"), then *why this asked* (the policy that fired), then three buttons — *Allow once*, *Allow and remember for this host*, *Deny* — with the narrowest remember as the default. Approvals are batched per step, never one modal per action; routine allowlisted actions never prompt; the owner can see and tune the escalation rate in Settings. The evidence is blunt: escalate-everything policies are *less* safe because a fatigued human rubber-stamps, and the safety-optimal escalation rate sits below "everything."
5. **Explain at the right depth** (G11; D-58): every run and every step has a *summary layer* — what happened, what it cost, what changed, what needs you, in at most three lines — above the raw timeline. Users diagnose failures 2.8× faster from structured summaries than from raw traces. Progressive disclosure is the rule: summary → step → call → payload; denials and fallbacks appear inline where they happened, with the reason.
6. **Dismiss, correct, and undo are always at hand** (G8, G9): Cancel on every running run; edit-and-continue and reject-with-feedback on every output; every document edit is a version, so nothing is destructive.
7. **Consequences before actions** (G16): starting an experiment or a compare shows the estimated cost and the daily cap remaining before the button; a workflow with validator smells shows them on the run form.
8. **Global controls stay visible** (G17): the network mode is a persistent banner with a one-click switch to offline; *Pause all* is on the Dashboard; budgets are on Settings.
9. **Feedback is one keystroke** (G15): rating is `1`–`5` on a focused output, approve/deny are `a`/`d`, next item is `j`/`k`. Feedback that costs a dialog does not get given.
10. **Plain language, honest tone** (D-59): every error states what happened, why, and what to do next, in one sentence each; no bare codes. Copy is warm and direct and never sycophantic — friendliness raises trust, agreement-seeking erodes it.
11. **Accessible by default** (D-59): WCAG 2.2 AA; shadcn/ui on Radix primitives with the focus ring raised to 3:1 contrast (the stock ring fails), visible focus for keyboard users only, `prefers-reduced-motion` respected, 4.5:1 text contrast in both themes, every control reachable by keyboard.
12. **Calm density**: one accent color for actions, semantic colors only for lifecycle states (`running`, `waiting_review`, `waiting_approval`, `interrupted`, `failed`, `completed`), monospace for prompts, traces, and JSON, no decorative motion — progress is data. It should feel like a good instrument panel, not a landing page.

## Navigation and screens

| Screen | Shows | Ships in |
|---|---|---|
| **Welcome** | the first-run path (workspace, provider or offline/mock, run the example, read the trace); reachable later from Settings | 00 |
| **Dashboard** | *Needs you* (approvals, blocking reviews, failures) · *Running* with budget bars and Cancel · *Today* (spend vs daily cap, next scheduled runs) · network mode · Pause all | 05 |
| **Library** | projects → documents and files → version history, diff between versions, edit (creates a version), "re-run downstream", export; knowledge import | 03 · 05 (re-run downstream) · 08 (knowledge import) |
| **Workflows** | list with versions; run form generated from `inputs` (strings, numbers, booleans, enums, string arrays, one level of objects; hand-built on shadcn inputs) with cost estimate and smell warnings; live DAG graph (`dagre` layout, SVG nodes, one node per map with item count) with per-step state, model, cost, Cancel and budget bar; schedule editor | 04 · 05 (schedules) |
| **Agents** | list with version hash, model policy, tools, granted vs requested permissions, load errors; run form | 01 · 06 (grants) |
| **Runs** | filterable list; summary layer per run and per step; trace timeline nested by step: compiled prompt, response, usage, cost, tool calls with results, permission decisions, fallbacks; Cancel and budget bar on running runs; Privacy Inspector tab (destinations, data categories, bytes, redacted bodies, provider data policy); "re-run with model X" | 00 (raw) · 01 (summary + timeline) · 02 (inspector) · 04 (cancel, budget) |
| **Review** | unreviewed outputs with rate / edit / reject-with-feedback / continue; blocking gates; approval cards (risk line, why, three buttons, narrowest remember default) | 05 · 06 |
| **Models** | catalog with availability (Ollama polled), capabilities, context, pricing, data policy; greyed by network mode; enable/disable | 02 |
| **Memory** | search by scope, inspect provenance and trust, delete with "also redact N traces" | 08 |
| **Tools** | built-ins, MCP servers and their tools, sandbox status; the tool × agent grant matrix (requested vs granted); per agent, the paths it may read and write and the repositories it may edit with the branches each may push to (read-only; written by hand, D-66); denial history; plugins with their manifests and the trusted-code warning | 06 · 09 (MCP, sandbox) · 11 (plugins) · 16 (repositories) |
| **Evaluate** | Compare (one step × N models side by side with latency, tokens, cost, variance, pick) with cost estimate first; datasets; experiments and results | 10 |
| **Settings** | workspace path, providers configured, network mode, budgets, retention, escalation rate (read-only from `GET /settings` at first); credentials editor (writes the 0600 file; never displays); MCP server configuration; "show the welcome path again" | 00 (read-only) · 11 |

## Empty states and errors

| Where | Empty state says | Offers |
|---|---|---|
| Runs | "Nothing has run yet. Runs appear here with what they cost and produced." | Run the example |
| Library | "Projects hold what your agents make. Every version is kept." | Create a project |
| Review | "Outputs wait here for your rating. Nothing is blocked unless a step asks." | — |
| Approvals | "Agents ask here before doing anything sensitive. You decide once; the narrowest rule is remembered." | Tune escalation |
| Models | "No provider configured. Add a key, or use local models offline." | Add a key · Go offline |

Every error follows *what happened · why · what to do*: "The run stopped: it reached its cost budget ($2.00). The last turn was saved as a partial draft. Raise the budget in Settings or re-run with a cheaper model."

## UX rules

- Every running run shows budget consumed and remaining and a Cancel button, everywhere it appears.
- Decisions are visible where they happened; an approval shows who decided and when.
- Nothing is modal-only; every queue has a screen and a CLI command.
- Keyboard-first: list navigation, `/` to search, `Esc` closes, the one-keystroke feedback keys above. Light and dark themes.
- Costs are shown as stored (D-08). Estimates are labeled as estimates.
- Produced HTML is opened as a folder or zip, never rendered in the app (D-43).
- Phone: the app is installable and Dashboard, Review, Runs summaries, and Library reading lay out for phone widths; push notifications deep-link to the item (D-61, RUN-12).
- Usability check before RUN-11 ships: a person who has never seen the app completes the five core tasks (configure, run, read a trace, approve, rate) from the Welcome path without help; what they stumble on becomes a fix, not a doc.

> Amendment (RUN-05, 2026-09-03): the workflow graph marks a `review: 'blocking'` step as one that waits for you, in the picture and in its text alternative — the shape of a workflow includes where it stops.

> Amendment (RUN-12, 2026-09-03): the phone layout.
>
> - A phone gets a **bottom tab bar** (Dashboard · Review · Runs · Library · More) and no sidebar; "More" opens the full navigation. Content comes first, so *Needs you* is above the fold on an iPhone rather than below three rows of links.
> - **Touch targets are at least 44px tall below `md`** and shrink above it: `Button`'s `sm` size is `min-h-11 md:min-h-8`, and the same applies to the theme selector and the network banner's one-click switch. The e2e measures every button, link, select and checkbox on each phone screen rather than trusting the classes.
> - **The Runs list is cards on a phone and a table on a desktop.** A five-column table on a 390px screen is a sideways scroll, which is how a phone layout fails. Long document paths in the Library wrap (`table-fixed` + `break-all`) for the same reason: one unbroken path pushes the whole page sideways.
> - The keyboard-shortcut hints are hidden below `md`: there is no keyboard to hint at.

> Amendment (RUN-15, 2026-09-05): the Models screen's one action is **Check for changes** — it polls local
> endpoints and asks every provider with a credential what it offers — and what it finds is a list of findings
> above the catalog, each with the provider's own name for the model rendered as text, the agents and steps that
> pin a retired one, and two buttons: accept (a catalog write, a new model landing disabled) and dismiss. A model
> an agent pins that the provider no longer offers wears a *pinned but retired* badge; one with no price on
> record wears *price unknown* and is not selectable.

> Amendment (RUN-17, 2026-09-05): the Workflows run form shows **Budgets** — the workflow's own caps and each
> step's — under the inputs, in words (`120 model calls · 400 tool calls · $10.00 · 90 min`), with the rule
> that a step's cap ends the step with a summary and the run's cap ends the run. The Tools screen's disk table
> shows a repository grant's `deny` prefixes beside the branches it may push to.

> Amendment (run/24, 2026-09-05): **Models** — an Enable/Disable button on every non-mock card, and a price form
> (input and output, dollars per million) on any cloud entry with no price in effect. **Tools** — the disk
> table's repository cell carries *Grant a repository…* (checkout path, branches) and a *Remove* per grant.
> **Settings** — a provider name is lowercased on save, and a bad one is refused with the rule.

> Amendment (RUN-13, 2026-09-05): **Workflows** — *New workflow* (blank, or a copy of one that exists; the id
> follows the name until typed) and, on a workflow, *Edit* and *Delete…*. The editor is forms over the file
> (D-62): the workflow's name, description, default project, inputs as rows (name, label, type, hint,
> required) and outputs; then one form per step — kind (agent, tool, map), agent or tool, model pin, input,
> *Only when*, review and what a rejection re-runs, where the output files — with add, remove, move up and
> move down. The graph beside the form is drawn from the draft on every keystroke and is not draggable; *This
> draft would not run* and *Worth a look* re-run on the draft, and Save stays disabled while the first is
> non-empty. A save is refused with the step named when the draft would not run, and with a line diff when the
> file changed on disk after it was opened; the person then loads what is on disk or saves the draft over it,
> explicitly. *Delete…* asks inline and says how many schedules go with the workflow. A file that failed to
> load offers *Delete…* and names `workbench workflows edit <id>`.

> Amendment (RUN-14, 2026-09-05): **Review** gains a *Permissions review* section above the queue, shown only
> when the auditor has left findings. Each finding is a card: a headline in the runtime's words (`researcher
> holds http.fetch and has never used it.`), the evidence as bullet lines (the age, the zero, the streak, the
> hosts), the auditor's note when it added one (rendered as text), and one button that says exactly what it
> will do — *Take back http.fetch from researcher*, *Stop asking before weaver uses artifact.write*, *Narrow
> researcher's hosts to api.example.com* — plus *Dismiss*. Pressing the button is the person writing the
> matrix, the same act as on the Tools screen; a finding with nothing to flip says so and offers only Dismiss.
> **Workflows** shows `permissions-review` with its schedule paused: the owner switches it on.

> Amendment (D-68, 2026-09-05): **Settings** gains *Which models do the work*: one column per role with its
> ordered list, each model's readiness in a word, move up, move down, remove, an *Add a model* pick list from
> the catalogue, and *Now:* the model the role comes to. One *Save models* for the card. **Agents** shows a role
> beside what it resolves to (`role:fast → anthropic/claude-haiku-4-5`) and, on the agent's page, *Would run on*.

> Amendment (F2, 2026-09-05): both run forms — an agent's and a workflow's — show **what the run will cost
> before it runs**: *About $0.01 to $0.03 · ~1.2k tokens in · beats on anthropic/claude-sonnet-5, …*, with the
> caveat and the cap the run would stop at, live as the inputs change. On the mock the line says there is no
> bill. A step whose role has nothing ready is named there before the button is pressed.

> Amendment (F3, 2026-09-05): **Dashboard** — *Today* becomes *Today and this month*: the month's spend against
> its cap with a second meter, where the month is heading at the current rate, and a notice when schedules are
> paused on it. **Settings** — the Budgets card is a form for the three money caps (per run, per day, per
> month); the rest of the block stays read-only there. `workbench spend` prints the same numbers, plus the last
> thirty days by model and by what was run.

> Amendment (F4, 2026-09-05): **Review** no longer shows a step's intermediate output (`output: { document:
> null }`) as unreviewed; the auditor's JSON, a map's per-item drafts and the like stay out of the queue. A
> blocking step is still shown, whatever its output setting.

> Amendment (F8, 2026-09-05): **Dashboard** — *Needs you* counts the permissions review's open findings in one
> line under the blocking items (`3 permission findings`, linking to Review). Findings block nothing, so they are
> never cards there; when nothing is blocked and findings are open, the empty state says "Nothing is blocked"
> rather than "nothing is waiting". `GET /dashboard` carries the count as `findings`.

> Amendment (F6, 2026-09-05): **Welcome** gains a fifth step, *Meet your companion*, which opens the shipped
> companion agent with the companion project chosen (`/agents/companion?project=companion`); an agent's run form
> reads `?project=` as its initial target project.
