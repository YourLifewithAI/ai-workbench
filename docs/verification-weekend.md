# Verifying the build

Two lists.

**Section 1 is yours.** Every item needs something a machine here does not have: your Windows
machine, your keys, your money, your phone, or your judgement. Eleven items, not sixty-seven.

**Section 2 is everything else**, moved to a gate that runs on every push, with the gate named
against each item so nothing was quietly dropped. If a machine can check it, a machine checks it —
and when a gate goes red, that is a defect report before you ever see it, which is the whole point.

The weekend run that produced this list found one real bug (the money caps counted a UTC month, so
the monthly reset fired at 8pm on the 30th for anyone west of Greenwich — D-70, now with its own CI
job) and three checklist items that misled rather than failed. That is a good yield, and it came
from the parts only a person could run. Those are the parts kept here.

---

## 1. Yours to run

### Before the look changes

These prove behaviour, not appearance, so a redesign cannot invalidate them. Do these now.

- [ ] **O-1 The key goes in, and never comes back out**

  Settings → *Credentials* → paste the Anthropic key → *Save*. Reload the page.

  **Expect:** `anthropic` listed as configured, the key never shown back, not even masked-then-revealed.
  Doctor's `credentials` and `file access` lines are `ok`. (You proved the ACL side of this already.)

- [ ] **O-2 The adapter against the real API**

  The one command that cannot move into the app, because it tests the app from outside it. The key
  lives in an environment variable for this window only.

  ```powershell
  $env:WORKBENCH_CRED_ANTHROPIC = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
  npm run contract -- --live anthropic
  git checkout -- tests/contract/fixtures
  Remove-Item Env:WORKBENCH_CRED_ANTHROPIC
  ```

  **Expect:** `contract: live against anthropic` and a green suite. The first line asks for the key
  without echoing it; the last forgets it. Pennies.

- [ ] **O-3 Which models do the work, and whether you agree**

  Settings → *Which models do the work*. Then Models → *Check for changes*.

  **Expect:** `capable` → `anthropic/claude-sonnet-5`. **`fast` and `cheap` currently resolve to
  `google/gemini-3.6-flash`**, because the shipped lists put Gemini ahead of Haiku and you have a
  Google key on file. That is working as built, and it is probably not what you want — drag Haiku
  above Gemini here if the cheap work should be Anthropic's. This is the decision, not the test.

  On *Check for changes*: findings against the catalog. Accept one new model and try to run on it —
  it is refused as *price unknown* until you type the price, which is deliberate (D-65).

- [ ] **O-4 A real run costs roughly what it said it would**

  Workflows → *Story pipeline*, mock unticked. Read the estimate, *Start run*. Then Dashboard →
  *Today and this month*.

  **Expect:** An estimate before, a cost per step after, the two within sight of each other, and the
  month's meter moving by that amount. Well under a dollar. If the estimate and the bill disagree by
  a lot, that is a finding worth telling me.

- [ ] **O-5 Prompt caching actually pays**

  Run the same agent twice with the same long instructions — the Weaver is a good one. Open the
  second run's *model-completed* event.

  **Expect:** `usage.cachedInput` greater than zero on the second call. This is the single biggest
  lever on the monthly bill, so it is worth confirming with your own eyes once.

- [ ] **O-6 The companion, for real — and the C-6 rerun**

  Library → *companion* → `about.md` → *Edit*, write a few true lines, save. Agents → Companion,
  **project set to `companion`**, tell it something you want remembered, mock unticked.

  **Expect:** A visible reply on the run page, the reply filed in the Library under `notes/…`, a
  `user`-scope item in Memory written by that run, and `## goals` in the compiled prompt carrying
  your `about.md`.

  *This is where your C-6 gets settled.* You saw a run ping `gemini-3.8-flash` and show no reply. I
  could not reproduce it here — the output path renders correctly, and the model text is stored as a
  plain string the run page knows how to show. Two things would tell us which it was: whether
  `capable` still resolves to Sonnet on that run (if it fell to Gemini, something made Sonnet
  unready), and whether the run's timeline shows `model-completed` with text or `model-aborted` with
  an error. If it happens again, send me the run id and I will read the trace.

- [ ] **O-7 Refused by name, under a real model**

  The mock only calls tools its fixtures tell it to, so these are the checks a real model has to
  drive. Run the *delegator* with nothing granted. Then Tools: grant `calc` to the Architect only,
  and ask both the Architect and the Planner for a sum.

  **Expect:** The delegator asks for `agent.delegate`, is refused **by name** in the trace, and the
  refusal is listed under *Refused* on Tools. The Architect's sum succeeds and the Planner's is
  refused — one grant, one cell, one agent.

- [ ] **O-8 Approvals: park, remember narrowly, time out**

  Grant `shell` to the Architect. Ask it to run `dir`. Approve with the **narrowest** *remember*.
  Ask for the same command again, then a different one. Leave one card unanswered.

  **Expect:** A card under *Needs you* with the risk in plain words and three buttons, narrowest
  first. The same command needs no second card; a different one does. The unanswered card becomes a
  denial on its own and the run ends refused, not hung.

- [ ] **O-9 The sandbox holds**

  Run *Build site* on a one-line brief. Open the resulting `index.html` from disk in a browser. Then
  tell the Builder, in its task, to write to `%USERPROFILE%\.ssh` and run again.

  **Expect:** A plan, files, a sandboxed check, a page that stands on its own. The `.ssh` write is
  denied **naming the policy** — never a stack trace, never a silent success.

- [ ] **O-10 The phone**

  Join the machine to your tailnet, `tailscale serve`, open the tokened URL from your iPhone, and add
  it to the Home Screen.

  **Expect:** It installs as an app with its own icon. Approve something and rate something from the
  phone. A push notification arrives for an approval and deep-links to it. Nothing is reachable from
  outside the tailnet.

- [ ] **O-11 Kept alive by Task Scheduler** *(unfinished from the last run)*

  `deploy.md` → *On Windows: at logon, with Task Scheduler*. Create the task, sign out and in.

  ```powershell
  schtasks /query /tn "AI Workbench"
  Test-Path "$HOME\wb-weekend\data\runtime.json"
  $rt = Get-Content "$HOME\wb-weekend\data\runtime.json" | ConvertFrom-Json
  "http://127.0.0.1:$($rt.port)/#token=$(Get-Content "$HOME\wb-weekend\data\runtime.token")"
  ```

  **Expect:** The query says *Running* and `Test-Path` says `True` **before** the URL is worth
  reading. Last time the URL came out as `http://127.0.0.1:/#token=`, which means those two files
  were absent — the task was not running, so there was nothing to open.

### After the look changes

The redesign will move all of this, so doing it twice is waste. Parked until the new design is settled.

- [ ] **O-12** Both themes readable on every screen, in your actual room, at your actual brightness.
- [ ] **O-13** The phone layout at 400px: thumb targets, nothing scrolling sideways, *Needs you* high.
- [ ] **O-14** Keyboard only, top to bottom: every screen reachable, focus always visible.
- [ ] **O-15** The copy. Does every button say what happens? Does every refusal explain itself in
      words you would use? This is the one no test can have an opinion about.

---

## 2. Proven by machine, on every push

Nothing here needs you. Each row names the gate that would go red. All 44 browser cases, 267 unit
and security cases, 51 contract cases and every definition-of-done suite ran green on `main` at the
time this list was written.

| Was | Now proven by |
| --- | --- |
| Welcome, all five steps | e2e *Welcome runs the example and reaches its trace*; *Welcome names the companion* |
| The token gate | e2e *token handshake: the fragment is consumed and scrubbed* |
| Agents list and a compiled prompt | e2e *the Agents screen lists the workspace agents*; *running an agent streams its text* |
| Streaming | e2e *running an agent streams its text* |
| Edit an agent on disk, reload | e2e *a broken definition is reported on the screen, and reload picks up the fix* |
| Models: states, reasons, offline | e2e *the Models screen lists what the local endpoint reports*; *going offline is one click* |
| Library: a run files a document, a human edit is a version | e2e *creating a project… files the output*; *a human edit becomes a second version* |
| Export a project | e2e *the exported folder is one a human can read* |
| Workflows: graph, generated form, run, cancel | e2e *the Workflows screen shows each workflow as a graph*; *running a workflow fills the graph*; *a running workflow can be cancelled* |
| A map step | DoD RUN-04 |
| A broken workflow file is data, not a crash | DoD RUN-04; e2e *a broken definition is reported* |
| Dashboard and the caps | e2e *the spending caps are set on Settings* |
| Edit a workflow as forms | e2e *a workflow is edited as forms*; DoD RUN-13 |
| Review by keyboard, reject with feedback | e2e *the Review queue rates an output*; DoD RUN-05 |
| A parked run survives a restart | DoD RUN-05 |
| A save against a moved file is refused | e2e *a project's space… saved hash-pinned*; DoD RUN-13 |
| Schedules | e2e *deleting a workflow says how many schedules go with it*; DoD RUN-05 |
| Tools: everything denied, and what each tool reaches | e2e *the Tools screen grants a tool, and the grant is what the runtime uses* |
| The same facts from the terminal | run here each round: `approvals list`, `tools grants` |
| An agent cannot widen its own grant | security suite (SEC, D-26/D-34) |
| Memory with provenance | e2e *the Memory screen remembers, shows provenance, and deletes with redaction* |
| The sandbox exists, and doctor agrees | e2e *the Tools screen says whether code can run at all*; the `no-sandbox` CI job |
| Evaluate | e2e *Compare runs two models side by side* |
| The permissions review on the mock | e2e *the permissions review lands in the queue* |
| Findings on the Dashboard | unit *dashboard-findings* |
| A project is a space | e2e *a project's space is a form on its Library page*; DoD RUN-18 |
| A project's agents first | e2e *with a project named, its agents come first* |
| The space from the terminal | run here each round: `projects show`, `projects space` |
| The estimate before a run | e2e *a workflow can be run with no provider key, and the form says so* |
| The phone layout | e2e *an approval is decided from the phone*; *the Library reads on a phone* |
| Spend, from the terminal | run here each round: `spend` |
| The install needs no Visual Studio | the `check (windows-latest)` CI job |
| The caps count your calendar, not UTC | the `timezone` CI job (D-70) |
