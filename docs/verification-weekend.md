# The weekend: verifying the whole build

A checklist for the owner, on Windows, in order. Every item says what to do, the exact commands where there are any, and what to expect. The runs' own scripts in `runlog/RUN-nn.md` are the long form; this is the consolidated pass. Tick as you go; write down what you saw when it is not what is expected (section F says what to capture).

Estimated time: sections 0 to C are an afternoon on the mock with no key and no cost; D is an hour and a few dollars; E needs Tailscale; B-6 needs a sign-out.


## 0. Before you start

Fifteen minutes. Everything below assumes a PowerShell window in the repository folder, Node 22 and Git installed, and a fresh window opened after any install so `Path` is current.


- [ ] **0-1 Pull and install**
  
  From the repository folder. Three install lines, one at a time (Windows PowerShell 5 has no `&&`).

  ```powershell
  cd ~\ai-workbench
  git pull
  npm ci --ignore-scripts
  npm rebuild deno esbuild
  npm run prepare
  ```
  
  **Expect:** No red. If `npm ci` alone ever asked for Visual Studio, that is the reason for `--ignore-scripts`; it should not with these lines.

- [ ] **0-2 Build**
  
  Produces `dist\`. About a minute.

  ```powershell
  npm run build
  ```
  
  **Expect:** Ends with the runtime build line (`ESM ⚡️ Build success`) and `dist\cli.js` exists: `Test-Path dist\cli.js` prints `True`.

- [ ] **0-3 The three programs the tests need**
  
  Node 22 or later, Git, and the Deno the install brought in (it does not need to be on Path).

  ```powershell
  node --version
  git --version
  npx deno --version
  ```
  
  **Expect:** `v22` or higher; a git version; a deno version. If `deno` is not found, `npm rebuild deno` again in a fresh window.

- [ ] **0-4 Playwright's browser, once**
  
  The browser tests drive Chromium. This downloads it the first time only.

  ```powershell
  npx playwright install chromium
  ```
  
  **Expect:** A download, then nothing. Run it again and it says the browser is already installed.

## A. The automated gates

The same gates CI runs, on your machine. Mostly waiting. Read the last lines of each: the words matter, not the scroll.


- [ ] **A-1 npm run check**
  
  Typecheck, lint, the unit and security suites, the adapter contract suite replayed from recordings, route-drift, secret-scan. Five to ten minutes.

  ```powershell
  npm run check
  ```
  
  **Expect:** Near the end: `route-drift: clean (85 routes, documented and implemented agree)` and `secret-scan: clean`. Above them, vitest lines with no `failed`: unit around 113 tests, security around 154, contract 51. Any `FAIL` line is a finding: copy the test name.

- [ ] **A-2 The browser suite**
  
  Starts a runtime on a temporary workspace and drives every screen, including the phone layout and an accessibility scan of each screen.

  ```powershell
  npm run e2e
  ```
  
  **Expect:** `44 passed` (the number may grow). If one fails, the output names the spec and the line; `test-results\` holds a trace you can zip up for me.

- [ ] **A-3 Every definition-of-done suite**
  
  All nineteen runs' DoD suites in one go. Two or three minutes. Two cases are live-only and skip.

  ```powershell
  npx vitest run --project dod
  ```
  
  **Expect:** `Test Files 19 passed` and `Tests 131 passed | 2 skipped` or higher. One run on its own is `npm run dod -- 18` (any two-digit run number).

- [ ] **A-4 Docker (optional)**

  Only if Docker Desktop is installed **and its engine is running** — open Docker Desktop first and wait for it to say *Engine running*; installed is not the same as started. Both lines are bash, and both must run from the repository, not from your home folder.

  ```bash
  cd ~/ai-workbench
  docker build -t ai-workbench:local .
  bash scripts/docker-smoke.sh ai-workbench:local
  ```

  **Expect:** The smoke script prints its items and exits 0. Skip cleanly if there is no Docker; CI covers it on Linux.

  Two failures that are not the build's fault: `failed to connect to the docker API` (or `Cannot connect to the Docker daemon`) means the engine is not up; `scripts/docker-smoke.sh: No such file or directory` means the shell is not in the repository. If a pasted line arrives with `^[[200~` in front of it, Git Bash took the paste literally — retype it.

## B. The Windows facts only you can check

CI runs Windows, but not your Windows: no Visual Studio, your profile, your shells, your Task Scheduler.


- [ ] **B-1 The install needed no Visual Studio**
  
  You already did this in 0-1. Tick it if `npm ci --ignore-scripts` and the rebuild ran with no compiler errors and no prompt to install build tools.
  
  **Expect:** No mention of `node-gyp`, `MSBuild` or Visual Studio in the install output.

- [ ] **B-2 The tilde in PowerShell**
  
  Neither shell expands `~` for a program it starts; the workbench does. Make a fresh workspace with it.

  ```powershell
  node dist\cli.js init ~/wb-weekend
  ```
  
  **Expect:** `Workspace created at C:\Users\<you>\wb-weekend`. Then `Test-Path .\~` in the repository prints `False`: no folder literally named `~` was made.

- [ ] **B-3 The tilde in cmd.exe**
  
  Open a Command Prompt (not PowerShell), go to the repository, and ask doctor about the same workspace with a backslash tilde.

  ```powershell
  cd %USERPROFILE%\ai-workbench
  node dist\cli.js doctor --workspace ~\wb-weekend
  ```
  
  **Expect:** The `workspace` line names `C:\Users\<you>\wb-weekend`, and every check is `ok`.

- [ ] **B-4 Start it, read the one line, stop it**
  
  Start the runtime on the weekend workspace. Leave the window open for sections C and D. Stop with Ctrl-C at the end of the weekend.

  ```powershell
  node dist\cli.js start --workspace ~/wb-weekend
  ```
  
  **Expect:** Exactly one line, a URL on `127.0.0.1` ending in `#token=…`. No Windows Firewall prompt (it binds to the loopback address; a prompt means something is wrong). After Ctrl-C later: `Test-Path ~\wb-weekend\data\runtime.json` prints `False`.

- [ ] **B-5 The credentials file is yours alone**
  
  After you paste a key in section D (item D-1), look at the file's permissions. Windows has no mode bits; the workbench sets an ACL.

  ```powershell
  icacls $HOME\wb-weekend\config\credentials.json
  node dist\cli.js doctor --workspace ~/wb-weekend
  ```
  
  **Expect:** `icacls` lists your account only (and no `BUILTIN\Users` or `Everyone` line). Doctor's `file access` check is `ok`. If you have a non-administrator account on this machine, the same two commands from it are the stronger proof.

- [ ] **B-6 Kept alive by Task Scheduler**
  
  `deploy.md`, section *On Windows: at logon, with Task Scheduler*: create the task with the `schtasks` command there, sign out and in, then read the URL from the workspace rather than from a window.

  ```powershell
  schtasks /query /tn "AI Workbench"
  Test-Path "$HOME\wb-weekend\data\runtime.json"
  $rt = Get-Content "$HOME\wb-weekend\data\runtime.json" | ConvertFrom-Json
  "http://127.0.0.1:$($rt.port)/#token=$(Get-Content "$HOME\wb-weekend\data\runtime.token")"
  schtasks /end /tn "AI Workbench"
  ```

  **Expect:** The first line lists the task and says *Running*; `Test-Path` says `True`. Only then is the URL worth reading, and it opens the Dashboard. `schtasks /end` stops it and the next `doctor` says the runtime is not running.

  If the URL comes out as `http://127.0.0.1:/#token=` — no port, no token — the two files are not there, so PowerShell filled the blanks with nothing. That is the task not running, not a broken URL: check the `schtasks /query` line above it. Do this one after B-4's runtime is stopped, or the two will fight over the workspace.

## C. The whole app on the mock, no key

Every screen, every run kind, on the built-in mock provider. Free. This is the long section; it follows the runs' own scripts in `runlog/`, consolidated.


- [ ] **C-1 Welcome, all five steps**
  
  Open the URL from B-4. *Try it with the mock*, *Run the echo agent*, *Open the trace*, then back to Welcome (Settings → *Show the welcome path again*) for *Open the companion*.
  
  **Expect:** The trace has six events. Expand *model-started*: the compiled prompt has `## identity`, `## task`, `## harness`, and your input as the user message. The companion opens with *Target project* set to `companion`.

- [ ] **C-2 The token gate**
  
  Paste the URL into a private window with the `#token=…` part removed.
  
  **Expect:** *Runtime token required*. Paste the token there and land on Runs.

- [ ] **C-3 Agents and a compiled prompt**
  
  Agents: fourteen agents, each with its model policy and a version hash. Open *The Architect*, type a premise, leave the mock ticked, run.
  
  **Expect:** A three-line summary, then the model call with the compiled prompt: identity, task, harness, and your premise as the user message. *Would run on* names a real model id even though the mock ran.

- [ ] **C-4 Streaming**
  
  Run *Echo* with the task `please be slow`.
  
  **Expect:** Text arrives in chunks under *Streaming* before the output replaces it.

- [ ] **C-5 Edit an agent on disk, reload**
  
  Edit `~\wb-weekend\agents\architect\instructions.md` (add a sentence), press *Reload from disk* on Agents, run it again.
  
  **Expect:** The version hash changed, and the new run's trace has a different `promptVersion`.

- [ ] **C-6 Models: states and reasons; offline**
  
  Models: every model with a state and a reason. Press *Go offline* in the banner, then *Go back online*.
  
  **Expect:** `mock/*` ready; the cloud models *no key*; offline turns every cloud model to *blocked by network mode* and the banner to *Network: Offline*.

- [ ] **C-7 Library: a run files a document, a human edit is a version**
  
  Library → *anthology* has `bible.md`. Agents → The Architect with *Target project* `anthology`, run. Then open `bible.md`, *Edit*, add a line, save, *Compare with the previous version*.
  
  **Expect:** A `beats/…` document appears, naming the run and the model. The bible has two versions, the second marked *human*, and your line shows in green in the diff. In the run's trace, `## knowledge` holds the bible inside a `content source=anthology/bible.md` fence.

- [ ] **C-8 Export a project**
  
  From the terminal, a second window.

  ```powershell
  node dist\cli.js export project anthology --out $HOME\anthology-export --workspace ~/wb-weekend
  ```
  
  **Expect:** A folder you can read without the workbench: the documents as files and a `manifest.json` saying where each came from.

- [ ] **C-9 Workflows: the graph, the generated form, a run, a cancel**
  
  Workflows → *Story pipeline*: Tab through the graph with the keyboard only. Fill the form (it comes from the workflow's own inputs) with a premise that contains the word `slow` (the mock's slow fixture answers those), *Start run*, watch the graph fill in. Start a second one the same way and press *Cancel* on Runs while it goes.
  
  **Expect:** Every step reachable and announced by keyboard. Steps light up one at a time. The cancelled run ends `cancelled`, not `failed`.

- [ ] **C-10 A map step**
  
  Run *Ensemble draft*.
  
  **Expect:** Several `draft[n]` item steps side by side, then one step that waits for all of them; the trace names a different model per item.

- [ ] **C-11 A broken workflow file is data, not a crash**
  
  In `~\wb-weekend\workflows\story-pipeline.workflow.json`, point one step's `{{steps.x.output}}` at a step id that does not exist. Reload Workflows. Put it back afterwards.
  
  **Expect:** That workflow is listed as broken with the reason; the others still run.

- [ ] **C-12 Dashboard and the caps**
  
  Dashboard: *Needs you*, *Running*, *Today and this month* with two meters. Settings → *Budgets*: set *Per day* to 5, *Save caps*, back to the Dashboard.
  
  **Expect:** The daily meter reads against $5.00. Set it back to 20 afterwards.

- [ ] **C-13 Edit a workflow as forms**
  
  Workflows → *Research briefing* → *Edit*. *Add a step*: id `factcheck`, agent *reviewer*, input `Check every claim.` then on a new line `{{steps.briefing.output}}`. Set its *Review* to wait for you. *Save workflow*, run it on the mock.
  
  **Expect:** The edge appears in the graph as you type the reference, before saving. After the save, a five-step graph; the run parks at `factcheck`.

- [ ] **C-14 Review by keyboard, reject with feedback**
  
  After C-25 the Research briefing has a step that waits for you. Run it on the mock. On Review use only the keyboard: `j`/`k` move, `1`–`5` rate, `c` continue, `r` reject, `Esc` closes. Reject the parked `factcheck` step with one sentence.
  
  **Expect:** The run parks as `waiting_review` and shows under *Needs you*. After the reject, the step runs again with your sentence in its *task* (open the trace: it is in the user message, not the system prompt), and the queue shows one row with *attempt 2*, not two rows. Story pipeline's outputs from C-9 take a 1–5 rating and keep it after a reload.

- [ ] **C-15 A parked run survives a restart**
  
  With a run parked at a gate, Ctrl-C the runtime window and start it again (B-4's command).
  
  **Expect:** The run is still `waiting_review`, not `interrupted`. Deciding it on Review resumes it.

- [ ] **C-16 A save against a moved file is refused**
  
  With the editor open on a workflow, change its description in Notepad on the file in `~\wb-weekend\workflows\`. Back in the browser change the name and *Save workflow*.
  
  **Expect:** A refusal showing the description line as changed, and the three choices. Nothing overwritten.

- [ ] **C-17 Schedules**
  
  Workflows → a workflow → *Schedule it*: pick a preset, add it, then pause it. Press *Pause all — go offline* on the Dashboard and undo it.
  
  **Expect:** *Next scheduled* on the Dashboard lists it; paused schedules do not fire; *Pause all* pauses every schedule and goes offline in one press.

- [ ] **C-18 Tools: everything denied, and what each tool reaches**
  
  Tools: the catalogue and the grant matrix.
  
  **Expect:** Every cell denied except the shipped grants (`workbench.json`'s six agents). Each tool's line says what it would be able to reach. *Refused* is empty until C-29.

- [ ] **C-19 The same facts from the terminal**

  ```powershell
  node dist\cli.js approvals list --workspace ~/wb-weekend
  node dist\cli.js tools grants --workspace ~/wb-weekend
  ```
  
  **Expect:** The approvals and the grant matrix as text, matching the screens.

- [ ] **C-20 An agent cannot widen its own grant**
  
  Edit `~\wb-weekend\agents\echo\agent.json` to ask for `fs.write` under `permissions.tools`, *Reload from disk*, look at Tools.
  
  **Expect:** The cell reads *requested*, not *allow*. Asking in a file grants nothing. Put the file back.

- [ ] **C-21 Memory with provenance**
  
  Run the Companion on the mock (its fixture remembers something about you). Open Memory. Write an item yourself in the form. Delete one **with redaction**.
  
  **Expect:** The companion's item is in the `user` scope, names the run that wrote it, and is `trusted`. Your own item is `trusted` too. The delete dialog says how many traces quoted the item before it offers; afterwards those traces show the quotation gone. (An `untrusted` item needs a run that fetched the web; the RUN-08 DoD suite proves that path.)

- [ ] **C-22 The sandbox exists, and doctor agrees**
  
  Tools → *What can run code*.

  ```powershell
  node dist\cli.js doctor --workspace ~/wb-weekend
  ```
  
  **Expect:** The screen shows the sandbox with its path and limits, or the exact list of tools switched off without it. Doctor's `deno` line says the same.

- [ ] **C-23 Evaluate**
  
  Evaluate → *Compare*: one step, two mock models, pick the better. Make a dataset from past run inputs, run an experiment over two models with a cost cap below what it would spend.
  
  **Expect:** Outputs, latency, tokens and cost side by side; the pick rates every pane. The experiment stops before a trial, not after one; every model-produced number is labelled *estimate*.

- [ ] **C-24 The permissions review on the mock**
  
  Workflows → *Permissions review* → *Start run* with the mock ticked (its schedule stays paused). On Review, press the button on one finding and *Dismiss* the other. Run it again.
  
  **Expect:** Two findings under *Permissions review*. Applying one flips that cell on Tools to *unset*. The second run raises nothing new.

- [ ] **C-25 Findings on the Dashboard**
  
  With a finding open, look at the Dashboard.
  
  **Expect:** One line under *Needs you*: `1 permission finding from the review is waiting in Review.`, and the count links to Review.

- [ ] **C-26 A project is a space**
  
  Library → *companion* → *Space*. Untick `memory.remember`, *Save space*. Agents → Companion (project `companion`), run it on the mock. Then tick it back and save.
  
  **Expect:** *Saved.* In the run's trace the companion's `memory.remember` call is refused: *"memory.remember" is not allowed in project companion*, and it appears under *Refused* on Tools. The compiled prompt has `## goals` after the companion's own sections, carrying `about.md`.

- [ ] **C-27 A project's agents first**
  
  Library → *anthology* → press the empty state's *Run an agent here* if it shows, or open `/agents?project=anthology` by hand.
  
  **Expect:** *This project's agents* lists the architect, the weaver and the cutter; *Others* follows; opening one has the project chosen.

- [ ] **C-28 The space from the terminal**

  ```powershell
  node dist\cli.js projects show anthology --workspace ~/wb-weekend
  node dist\cli.js projects space anthology --agents architect,weaver --workspace ~/wb-weekend
  node dist\cli.js projects space anthology --agents architect,weaver,cutter --workspace ~/wb-weekend
  ```
  
  **Expect:** The space printed in words; the second command changes the agents; the third puts them back. The Library page shows the same after a reload.

- [ ] **C-29 The estimate before a run**
  
  Workflows → *Story pipeline*: with the mock ticked the form says *On the mock: no bill*. Untick it (with no key yet).
  
  **Expect:** An estimate line appears, or an honest *No estimate* with the reason when no model is ready.

- [ ] **C-30 Both themes, one keyboard**
  
  Switch the theme selector in the sidebar to *Dark* and *Light*; then, with the mouse untouched, Tab from the top of the page through the sidebar to every screen.
  
  **Expect:** Both themes readable everywhere you looked; every screen reachable; a visible focus ring on every stop.

- [ ] **C-31 The phone layout, without a phone**
  
  Make the browser window about 400 px wide.
  
  **Expect:** A bottom tab bar (Dashboard · Review · Runs · Library · More), no sidebar, the network banner on one line, and *Needs you* in the top third of the Dashboard.

- [ ] **C-32 Spend, from the terminal**

  ```powershell
  node dist\cli.js spend --workspace ~/wb-weekend
  ```
  
  **Expect:** Today, this month against the cap, the projection, and the last thirty days by model and by subject. On the mock the amounts are what the same prompts would have cost.

## D. With your Anthropic key

A few dollars at most. The checks that only a real model proves.


- [ ] **D-1 Paste the key on Settings**
  
  Settings → *Credentials*: name `anthropic`, paste, save. Never put it in a file by hand, never in a chat.
  
  **Expect:** `anthropic` listed as configured; the key never shown back. Now do B-5. Doctor's `credentials` line is `ok`.

- [ ] **D-2 Check for changes at Anthropic**
  
  Models → *Check for changes*. Read the findings before accepting anything. Accept one *new* model; try to run an agent on it; dismiss another finding and press *Check for changes* again.
  
  **Expect:** Findings against the catalog. The accepted model is *disabled* and *price unknown*, and running on it is refused for that reason. The dismissed finding stays silent.

- [ ] **D-3 Which models do the work**
  
  Settings → *Which models do the work*.
  
  **Expect:** *capable* resolves to `anthropic/claude-sonnet-5`. What *fast* and *cheap* come to depends on which keys are on file: the shipped lists put `google/gemini-3.6-flash` **ahead of** `anthropic/claude-haiku-4-5`, so with a Google key on file those two roles run on Gemini, and with only an Anthropic key they run on Haiku. Neither is a failure. If you want Anthropic doing that work whichever keys are present, drag Haiku above Gemini on this screen — that is the only place to change it, and it changes what runs a minute later.

- [ ] **D-4 The adapter against the real API**
  
  The contract suite, live. The key goes in an environment variable for this window only. This rewrites the recordings under `tests\contract\fixtures\`; discard them afterwards unless we decide to keep them.

  ```powershell
  $env:WORKBENCH_CRED_ANTHROPIC = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
  npm run contract -- --live anthropic
  git checkout -- tests/contract/fixtures
  Remove-Item Env:WORKBENCH_CRED_ANTHROPIC
  ```
  
  **Expect:** `contract: live against anthropic` and a green suite. The first line asks for the key without echoing it; the last forgets it.

- [ ] **D-5 The story pipeline for real**
  
  Workflows → *Story pipeline*: mock unticked, read the estimate, *Start run*. Then Runs → the run, Review, Library.
  
  **Expect:** An estimate before, cost per step after; the final draft waits on Review; the drafts sit in the Library under *anthology*. Well under a dollar.

- [ ] **D-6 Prompt caching**
  
  Run the same agent twice with the same long instructions (the Weaver is a good one). Open the second run's *model-completed* event.
  
  **Expect:** `usage.cachedInput` is greater than zero on the second call: the stable prefix was served from Anthropic's cache.

- [ ] **D-7 The companion, for real**
  
  Library → *companion* → open `about.md`, *Edit*, write a few true lines, save. Agents → Companion → tell it something you want remembered, run on the real model.
  
  **Expect:** The reply is filed under *companion* in the Library as `notes/…`; Memory holds a `user`-scope item written by that run; the compiled prompt carried your `about.md` under `## goals`.

- [ ] **D-8 The permissions review on the real model**
  
  Workflows → *Permissions review*, mock unticked. A few cents.
  
  **Expect:** Findings whose *The auditor adds* line reads like a considered sentence about your grants, not the mock's canned two.

- [ ] **D-9 The month moved**
  
  Dashboard → *Today and this month*, and the terminal.

  ```powershell
  node dist\cli.js spend --workspace ~/wb-weekend
  ```
  
  **Expect:** Real dollars, small ones, by model (`anthropic/…`) and by what ran. The projection is honest about a two-day sample.

- [ ] **D-10 A live DoD (optional)**
  
  The story pipeline's live DoD case was written for a Gemini key and skips without `WB_LIVE`. With roles it may run on your key; if it refuses, that is expected, not a failure.

  ```powershell
  $env:WB_LIVE = '1'
  npm run dod -- 04
  Remove-Item Env:WB_LIVE
  ```
  
  **Expect:** Either a story draft under a dollar, or a skip naming the missing provider.

- [ ] **D-11 Refused by name, on Tools**
  
  Run the *delegator* agent on the real model with nothing granted to it.
  
  **Expect:** It asks for `agent.delegate`, is refused by name in the trace, and the refusal is listed under *Refused* on Tools.

- [ ] **D-12 A grant is for one agent**
  
  Tools: grant `calc` to the Architect. Ask the Architect for a sum in its task; ask the Planner for the same.
  
  **Expect:** The Architect's call succeeds; the Planner's is refused. The grant changed one cell.

- [ ] **D-13 Approvals: park, remember narrowly, time out**
  
  Grant `shell` to the Architect and ask it to run `dir` (or `ls`). Approve with the narrowest *remember*. Ask for the same command again, then a different one. Leave one card unanswered.
  
  **Expect:** A card under *Needs you* with the risk in plain words and three buttons, narrowest first. The same command needs no second card; a different one does. The unanswered card becomes a denial on its own and the run ends refused, not hung.

- [ ] **D-14 Build a site, and try to break out**
  
  Run *Build site* on a one-line brief (the Builder holds `code.execute` and writes under `projects/site/`). Open `~\wb-weekend\projects\site\files\site\index.html` from disk. Then tell the Builder in its task to write to `%USERPROFILE%\.ssh` and run again.
  
  **Expect:** A plan, files, a sandboxed check, a reviewer's note; the page stands on its own in a browser. The `.ssh` write is denied naming the policy, never a stack trace and never a silent success.

## E. The phone

Optional. Needs Tailscale on this machine and on the phone (`deploy.md` §2–3), or a trusted home Wi-Fi without push.


- [ ] **E-1 Reach it from the phone**
  
  `deploy.md` §2–3: Tailscale on this machine and the phone, `tailscale serve`, start with `--expose <tailnet hostname>`. Open the tokened URL in Safari.
  
  **Expect:** The phone layout: bottom tab bar, Runs as cards, targets you can hit without aiming.

- [ ] **E-2 Install it**
  
  Share → *Add to Home Screen*, open it from there.
  
  **Expect:** No Safari chrome, still signed in. If it asks for the token again, that is the finding.

- [ ] **E-3 A notification that deep-links**
  
  In the installed app, Settings → *Notifications*: turn on *approval requested* and *needs review*. From the laptop, grant `shell` to an agent and run it.
  
  **Expect:** iOS asks for permission when you flip the toggle, not at load. The approval arrives as a notification and opens the card.

- [ ] **E-4 Approve and rate from the phone**
  
  Answer the approval; rate an output on Review.
  
  **Expect:** Both land; the laptop's Dashboard updates without a reload.

## F. When something fails

What to capture so the fix is one message.


- [ ] **F-1 Capture the state**

  ```powershell
  node dist\cli.js doctor --workspace ~/wb-weekend --json > $HOME\doctor.json
  node --version; git --version
  ```
  
  **Expect:** A `doctor.json` in your home folder. Send it with the failure.

- [ ] **F-2 Capture the run**
  
  For a run that went wrong: Runs → the run → *Download trace*, or from the terminal.

  ```powershell
  node dist\cli.js trace <runId> --workspace ~/wb-weekend > $HOME\trace.txt
  ```
  
  **Expect:** The trace holds every event; the redactor has already removed any secret. Send it.

- [ ] **F-3 Capture a test failure**
  
  Copy the `FAIL` line and the `AssertionError` under it; for the browser suite, zip `test-results\`.
  
  **Expect:** One message to me with the item number from this list, the command, and what you saw. That is enough to fix it.


## Afterwards

- Stop the runtime (Ctrl-C) and confirm `~\wb-weekend\data\runtime.json` is gone.
- If you ran D-4, `git status` should be clean; if the recordings changed, `git checkout -- tests/contract/fixtures`.
- Send me the list of item numbers that failed or surprised you, with what you saw. A pass with nothing to report is also a result worth sending: it moves `STATUS.md` from *awaiting verification* to verified.

