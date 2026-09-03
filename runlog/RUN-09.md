# RUN-09 handoff — Sandbox, filesystem, code execution, MCP, and the website workflow

**Branch:** `run/09-sandbox` · **Head:** _(filled at push)_ · **Status:** awaiting verification

## Built
- `src/runtime/sandbox/deno.ts` — the sandbox (D-30). `sandboxFlags()` generates permissions from the effective policy and nothing else: read roots, write roots, `--no-prompt`, a heap ceiling, and `--deny-net --deny-run --deny-ffi` named explicitly so a future Deno that widens a default cannot widen this sandbox silently. Wall clock, memory and output limits, with a kill that is the result rather than an error to retry. `runCommand()` is `shell`, in the same module because process spawning belongs in one place.
- `src/runtime/sandbox/bridge.ts` — the tool bridge (D-55). A call is one line on stdout with a per-run nonce; the reply comes back on stdin, synchronously, so there is no background reader keeping the process alive after the script is done. `tools` is a Proxy: any name may be called, and the broker answers.
- `ToolExecutor.runScript()` — every bridged call re-enters `one()`, the same method a model's tool call goes through. Grants, approvals, DNS pinning, the egress log, the exfiltration rule and the trace all apply without a second code path. That is the whole point: one door, not two.
- `fs.read`, `fs.list` (write-tier) and `fs.write` (execute-tier) outside the project, through the broker's canonicalization; `code.execute` and `shell` (approval by default, because a subprocess's network cannot be policed); `http.request` for non-GET, which is what the exfiltration rule's non-GET branch was written for.
- `src/runtime/mcp/` — a stdio JSON-RPC client, a host that starts every configured server at boot, and an adapter that turns published tools into `mcp.<server>.<tool>` definitions. A tool the server did not annotate read-only is write-tier and asks a human every time. Servers get the same scrubbed environment as any child; `childEnv` refuses a credential variable.
- Tools screen: **What can run code** (the sandbox, its path and its limits, or exactly which tools are switched off without it) and **MCP servers** (running or not, why not, and what each publishes). `workbench doctor` says the same thing from the terminal.
- `examples/workspace/agents/builder/` and `workflows/build-site.workflow.json` — a brief becomes a plan, the plan becomes files, a sandboxed check reads them back through the bridge, and a reviewer says what a visitor would notice.
- CI: the check job runs every DoD suite with Deno installed (it is a devDependency, so `npm ci` provides it); a `no-sandbox` job deletes the binary and runs the same suites on a machine that genuinely has none. The Docker image carries Deno, and the smoke test asserts the shipped image has a sandbox.

## Not built (deliberate)
- Python, a container sandbox, and serving an agent's HTML from the runtime origin — the brief's *Do not*, and the last one is SEC-31.
- Plugins (RUN-11).
- Any in-process execution path. `node:vm` was already banned by lint; a DoD case now greps `src/` for `eval(` and `new Function(` as well, because a ban nobody tests is a comment.

## Deviations from the brief
- **The bridge is stdout and stdin, not fd 3.** Deno 2 removed the APIs for reading an arbitrary fd, and a nonce on stdout does the same job: it separates printing from calling. Amended.
- **A script may name any tool.** The brief's DoD asks for an ungranted call to come back as `PermissionDenied`, which means the name has to exist to be refused. `tools` is a Proxy over the broker rather than a fixed list. Amended.
- **A ceiling narrows only what it mentions.** A workflow whose `permissions` block lists `tools` and no paths kept stripping its agents' filesystem grants to nothing — the first shipped workflow with such a block could not write a file. Amended.

## Verification transcript
```
$ npm run check
typecheck · lint · unit · security · contract · secret-scan — green
$ npm run dod -- 09
7 passed (the sandbox cases on real Deno, the MCP cases on the reference filesystem server)
$ npx vitest run --project dod
every suite, 00 through 12 — green
$ npm run e2e
green, axe clean on every screen
```

## SEC tests added
`tests/security/sec-21-24-sandbox.test.ts`, 15 cases:
- **SEC-21** `..` out of a granted root, in two spellings, and the same file readable when the grant covers it; a symlink inside a granted root pointing outside; a write through a symlink leaving its target untouched; and the case rule asserted per platform rather than assumed.
- **SEC-22** a script cannot enumerate its own environment at all (no `--allow-env` is ever generated), nor read one variable by name; `fetch` and `Deno.connect` both fail `NotCapable`; a write outside its roots fails and the file does not appear; a read outside its roots fails and the secret is not in the output; a runaway loop is killed on the clock; a script that prints without stopping is killed on output; `Deno.Command` is refused, which is why it cannot escape.
- **SEC-23** the generated flags never include `--allow-net`, `--allow-run`, `--allow-ffi`, `--allow-all`, `-A`, `--allow-env` or `--unstable`; a sandbox with no Deno throws rather than falling back; and a whole runtime without one reports the execute tier unavailable by name.
- **SEC-24** an MCP write tool is write-tier with approval by default, a refused write never reaches the server, no credential appears in the trace, and `childEnv` throws rather than hand a `WORKBENCH_CRED_*` variable to any child.

## Bugs found by the tests
- **A workflow's `permissions` block stripped filesystem grants.** `build-site` could not write a file: the ceiling declared tools and no paths, and an empty list was read as "no paths" rather than "no opinion".
- **The first bridge kept the sandbox alive forever.** A background reader on stdin meant the script finished and the process did not; every `code.execute` hit the 30-second wall clock. Synchronous reads fixed it, and made the preamble half the size.
- **`callIndex` cannot script a three-agent workflow**, for the same reason it cannot script a parallel map: it counts every call the run makes. The DoD fixtures key on `afterTool` and on what the agent was asked.

## Spec amendments made
- `spec/tools-and-security.md` — the bridge channel, any-name calls, the explicit deny flags, and ceilings that narrow only what they mention

## For the next run (RUN-10: evaluation)
- `datasets`, `cases`, `experiments`, `experiment_runs` and `scores` are in `data-model.md` and have no tables yet. Everything an experiment needs to *run* exists: the engine takes a `modelOverride` per step, budgets carve per run, and `runs.kind` already has `experiment` in its vocabulary.
- The judge agent in the example workspace (`agents/judge/`) is the evaluator shape RUN-10 formalises.
- `code.execute` is what a programmatic evaluator should be: a scorer is a script with the bridge, not a plugin, until someone needs one that a script cannot express.

## Still outstanding for the owner
- The same two as before: no cloud adapter has spoken to its provider, and the phone has only been seen at an iPhone viewport in Chromium.
- The human script for this run: run `build-site` on a brief you care about, open `projects/site/files/site/index.html` from disk, and then try telling the Builder in its instructions to write to `~/.ssh` — the denial names the policy that refused it.
