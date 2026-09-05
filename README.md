# AI Workbench

A local-first, model-agnostic runtime for automated multi-agent, multi-model workflows.

Models are a replaceable substrate. Everything private — config, agents, runs, memory, keys — lives in one
workspace directory you own. The runtime is one process on one port that never faces the public internet, and
every capability it has is denied until you grant it.

**Status:** RUN-00 … RUN-12 are built. See [`STATUS.md`](STATUS.md) for what is verified and what is not, and
[`runlog/`](runlog/) for what each run actually did.

## Ten minutes

Requires Node 22. Deno is optional and unlocks the code-execution tools; the workbench says so if it is missing.
On Windows, [the first hour on Windows](docs/first-hour-windows.md) is this section as a walk, with the detours.

Install, then build:

```sh
npm ci            # on Windows: npm ci --ignore-scripts && npm rebuild deno esbuild && npm run prepare
npm run build
```

<details>
<summary>Why Windows installs differently</summary>

`better-sqlite3` ships a prebuilt Windows binary and loads it in preference to a compiled one — but it also
carries a `binding.gyp` with no install script, so npm compiles it anyway, and that needs Visual Studio.
Skipping install scripts and re-running the two that fetch real binaries (`deno`, `esbuild`) avoids the
toolchain entirely. Plain `npm ci` works too if you have the *Desktop development with C++* workload.
</details>

Then start it:

```sh
node dist/cli.js init ~/my-workspace
node dist/cli.js start --workspace ~/my-workspace
```

`start` prints one line: a URL ending in `#token=…`. Open it. The Welcome path runs the example agent on the
built-in mock provider — no key, no network — and shows you its trace.

`~` works in every one of these commands on Windows too. Neither cmd.exe nor PowerShell expands it, so the
workbench does: `~/my-workspace` is `C:\Users\you\my-workspace`, and `~\my-workspace` is the same place.

Then, in the UI:

1. **Run something.** Workflows → `story-pipeline` → run it. Watch the graph fill in step by step. With no
   provider key configured, *Use the mock provider* is already ticked, so the whole pipeline runs for free; the
   tick clears itself once you add a key.
2. **Read a trace.** Runs → the run you just made. Every model call, every tool call, every byte that tried to
   leave the machine, in order.
3. **Grant a tool.** Tools → the matrix. Nothing is granted until you say so, and the screen says what each
   tool would be able to reach.
4. **Approve something.** Grant `shell` to an agent and run it: the run parks and waits for you.
5. **Rate something.** Review → rate the output 1–5. That is the beginning of your own eval set.

Headless, with no runtime running — every command starts an ephemeral one for its own duration:

```sh
node dist/cli.js run agent echo --input "hello" --provider mock --json --workspace ~/my-workspace
node dist/cli.js trace <runId> --workspace ~/my-workspace
node dist/cli.js doctor --workspace ~/my-workspace
```

## Using a real model

Settings → Credentials in the UI, or from a shell:

```sh
echo "$YOUR_KEY" | node dist/cli.js settings set-credential google --workspace ~/my-workspace
```

```powershell
# PowerShell
$env:YOUR_KEY | node dist/cli.js settings set-credential google --workspace ~/my-workspace
```

The key goes into `config/credentials.json`, readable only by your account, and is never read back out — not by
the UI, not by the API, not into a trace. On Linux and macOS that is mode 0600; Windows has no mode bits, so it
is a file ACL instead, applied on save, and the workbench refuses to start if another account can read the file.
`WORKBENCH_CRED_GOOGLE` works too, if you would rather it lived in your environment.

Providers today: Google (Gemini), Anthropic, and anything OpenAI-compatible, including local endpoints like
Ollama and LM Studio. Adding one is writing an adapter that passes the contract suite — see `CONTRIBUTING.md`.

## What it does

- **Agents** are directories: `agent.json` plus `instructions.md`. Sections in the file become sections in the
  prompt, in order, and the prompt is in the trace.
- **Workflows** are a DAG in one JSON file: steps that name agents, tools, or a `map` over a list. A reference
  to another step's output *is* the dependency; there is nothing else to declare.
- **The Library** keeps every version of everything an agent wrote, with the run that wrote it.
- **Memory** is what agents carry between runs, with provenance. An item written by a run that had read the web
  is `untrusted`, and untrusted memory reaches a model fenced as data — never as an instruction.
- **Review** is where you rate and reject; **Approvals** is where the runtime waits for you before it does
  something that cannot be undone. They are different queues on purpose.
- **Evaluate** compares models on your own work: one step, N models, side by side, and a pick that becomes data.
- **The phone**: the UI installs to a Home Screen and can send you a notification when something needs you.

## Security floor

Bound to `127.0.0.1`; a bearer token per start (printed once, stored readable only by you); Host and Origin
checked before the token; strict CSP; credentials stored the same way and redacted from every trace, log and
response; child processes get an explicitly constructed environment; a secret scanner in the check gate.
"Readable only by you" is mode 0600 on Linux and macOS and a file ACL on Windows, which has no mode bits.

Beyond that floor: every tool is denied until granted, and the grant matrix is the authority — what an agent
asks for in its own file is a request. Code runs in a Deno sandbox with no network and no filesystem beyond what
you granted, reaching its tools through a bridge where every check still applies. Every outbound request is
checked against the network policy *before* DNS, re-checked on every redirect, and pinned so the address the
checker approved is the address the socket gets. A run that has read your private data and then reaches for a
host nobody allowed waits for you.

Each of these has a test in `tests/security/` that stays forever ([`spec/sec-catalog.md`](spec/sec-catalog.md)).

## Deploying

[`deploy.md`](deploy.md): Docker on a VPS reached over a Tailscale tailnet, with a Caddy alternative for people
without one. The runtime is never exposed directly, in any of them.

## How this repository is built

The specification in [`spec/`](spec/) is the source of truth. It is written to be executed by coding agents in
sequential runs (`spec/runs/RUN-nn.md`), each with a definition of done that is a command rather than a
judgment: `npm run check`, `npm run dod -- nn`, `npm run e2e`. Every run ends with a handoff in `runlog/` and a
human verification script. The protocol is in [`spec/runs/README.md`](spec/runs/README.md); `AGENTS.md` is the
entry point for an agent.

## License and contact

Apache-2.0 (see `LICENSE` and `NOTICE`). Security reports: [`SECURITY.md`](SECURITY.md). Questions:
[`SUPPORT.md`](SUPPORT.md). Contributing, including the adapter on-ramp: [`CONTRIBUTING.md`](CONTRIBUTING.md).
