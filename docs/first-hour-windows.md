# The first hour, on Windows

This is the owner's first hour with the workbench on a Windows machine, cleaned up: what to install, what to
type, what each thing on the screen is for, and the four places the first attempt tripped. Everything here
is PowerShell, one line at a time. Nothing needs administrator rights, WSL, or Visual Studio.

If you are on Linux or macOS, the README's *Ten minutes* is the same walk without the Windows detours.

## Before the clone

Two programs, from their own installers or from `winget` in a PowerShell window:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Then **close that window and open a new one**. An installer adds itself to `Path` for windows opened after
it; the one you ran it from does not see the change, and `node` or `git` "is not recognized" until you open
a fresh one. Check with:

```powershell
node --version     # v22 or later
git --version
```

Windows spells the search path `Path`, where Linux spells it `PATH`. The workbench treats them as the same
variable, so a `Path` that has `git` on it is one the workbench's tools can use. An early build did not, and
`doctor` reported git and Deno missing on a machine that had both; if you ever see that again, it is a bug,
not your machine.

## The clone and the build

```powershell
cd ~
git clone https://github.com/YourLifewithAI/ai-workbench.git
cd ai-workbench
npm ci --ignore-scripts
npm rebuild deno esbuild
npm run prepare
npm run build
```

Three install lines rather than the README's one `npm ci`, because one dependency (`better-sqlite3`) would
otherwise try to compile itself and ask for a C++ toolchain it does not need: it ships a prebuilt Windows
binary and uses that. Skipping install scripts and re-running the two that fetch real binaries avoids the
whole toolchain. Type them as separate lines: Windows PowerShell 5 (the one Windows ships) does not accept
`&&` between commands, only PowerShell 7 does.

`npm run build` takes a minute and produces `dist\`. Everything you run from now on is `node dist\cli.js …`
from this directory.

**Deno** is one of the packages that install brought in. It is the sandbox: the only place an agent's code
runs (`code.execute`, `shell`, `fs.write`), with no network and no filesystem beyond what the tool's grant
says. You do not run it yourself and it does not need to be on `Path`; the workbench finds the copy under
`node_modules`. Without it those three tools are switched off by name and everything else works.

## The workspace

```powershell
node dist\cli.js init ~/wb
```

That makes `C:\Users\you\wb` and fills it with the example workspace: fourteen agents, six workflows, a
config, an empty database. It is a folder you own. Back it up like any other folder; there is nothing in the
repository that is yours.

The `~` is expanded by the workbench, not by the shell. Neither cmd.exe nor PowerShell expands `~` for a
program they start, so an early build made a folder literally named `~` inside the repository
(`C:\Users\you\ai-workbench\~\wb`). That is fixed: `~/wb` and `~\wb` both mean `C:\Users\you\wb`, and
`init` prints the full path it made. If you would rather see no tilde, `C:\Users\you\wb` works everywhere it
is written here.

## Start it

```powershell
node dist\cli.js start --workspace ~/wb
```

It prints one line: a URL on `127.0.0.1` ending in `#token=…`. Open it in a browser (the token is the
password; the fragment never leaves the browser). Leave this window open. Ctrl-C stops the workbench
cleanly. No firewall prompt appears, because nothing is listening on a public address; if one does, stop.

The first screen is **Welcome**: four steps that run the *echo* agent on the built-in mock provider and open
its trace, with no key and no network. Do those four. The trace is the thing to look at: every run keeps
every event, and reading a run means reading that.

## The key

Settings → **Credentials**. Paste the Anthropic key, name it `anthropic`, save. It is written to
`config\credentials.json` in the workspace with a file ACL that only your account can read, and the workbench
refuses to start if that ACL is ever wider. Nothing reads the key back out: not this page, not a trace, not
a log.

Then **Models → Check for changes**. The workbench asks Anthropic what it offers now and shows the
differences from its catalog as findings; accept the ones you want. Nothing is applied until you say so.

Then Settings → **Which models do the work**. Every shipped agent names a *role* (`capable`, `fast`,
`cheap`) rather than a vendor's model, and this card shows which ready model each role resolves to right
now. With one Anthropic key that is Sonnet for *capable* and Haiku for *fast* and *cheap*, so every example
runs on that one key. Reorder a list if you want a different first choice; the first model that is ready
wins.

## The first real run

Workflows → **story-pipeline** → *Run it*. Two things above the button:

- **The estimate.** Before anything runs, the form says what the run is likely to cost on the models the
  roles resolve to, from the prompts' size and the step count. Tool loops and output lengths are guesses and
  it says so.
- **Use the mock provider (free, no key)** was ticked before you had a key and cleared itself when you added
  one. Tick it again any time you want a free rehearsal.

Run it. The graph fills in step by step. When it is done: **Runs** → the run, for cost per step; **Review**,
where the final draft waits for a rating (1 to 5, or reject with feedback); the
**Library**, where the drafts landed as documents with the run that wrote them.

Dashboard → *Today and this month* shows the run against the daily cap and the month against the monthly
one. The caps are on Settings → **Budgets**; the month's default is $100, and scheduled runs pause when it is
reached.

## The first workflow edit

Workflows → **story-pipeline** → *Edit*. It is a form, not the JSON: inputs, steps in order, outputs, with
the graph redrawn as you change things and a note when a step references an output that does not exist.
Change the `final` step's model role from `fast` to `capable`, *Save workflow*, run it again, and compare
the two runs' cost per step on Runs. That is the whole editing loop; nothing here needs a text editor.

To make a new one, **New workflow** → *Copy of* story-pipeline, rename it, and take steps out.

## Your own agent

Agents → **Companion**, with the *Target project* set to `companion` (Welcome's last step opens it that way).
It is the one agent that is yours: it reads `about.md` in the companion project as your word about yourself,
remembers what you tell it in the `user` scope of Memory, files each exchange as a note in the Library, and
spends inside its own caps ($2 a day, $20 a month as shipped) within the workspace's. Fill in `about.md` from
the Library first; an empty page makes for a companion that knows nothing about you.

## What each screen is for

- **Dashboard** — what needs you (approvals, blocking reviews, failures, the permissions review's findings),
  what is running, today and this month against their caps. Open this first, every time.
- **Review** — outputs waiting for a rating, gates waiting for a decision, approvals waiting for a yes, and
  the permissions review's proposals. Ratings become your own eval set.
- **Runs** — every run, live, with cost. A run opens to its trace: prompts, responses, tool calls, bytes that
  tried to leave the machine, in order.
- **Library** — every version of everything an agent wrote.
- **Workflows** — the six shipped pipelines, runnable and editable.
- **Agents** — the fourteen shipped agents: what each is told, which model it gets now, and a run form.
- **Models** — the catalog, what is ready, prices, and *Check for changes*.
- **Memory** — what agents carry between runs, with where each item came from.
- **Tools** — the grant matrix. Nothing is granted until you grant it; the screen says what each tool reaches.
- **Evaluate** — one step, several models, side by side, and a pick that becomes data.
- **Settings** — workspace, credentials, which models do the work, caps, push notifications, plugins.

## When something is off

```powershell
node dist\cli.js doctor --workspace ~/wb
```

It checks Node, the workspace, the credentials file's ACL, model roles, the sandbox, and the database, and
says what to do about each. Run it whenever a screen says something is unavailable.

## Later

- **Updating.** In the repository: `git pull`, the three install lines, `npm run build`, then stop and start
  the workbench. The workspace is untouched by an update.
- **Keeping it running** across logins is a scheduled task, not a service; the recipe is in `deploy.md`
  under *On Windows*.
- **The phone** reaches it over Tailscale, never over the open internet; also in `deploy.md`.
- **Moving to Linux.** The workspace folder copies over as it is. The credentials file needs to be readable
  only by you there too (`chmod 600 config/credentials.json`), and `doctor` says so if it is not. The install
  is the README's one `npm ci`.
