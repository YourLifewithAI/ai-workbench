# RUN-16 handoff — Repository tools

Branch `run/16-repository-tools` · code at `63df105` · brief: `spec/runs/RUN-16.md` · decision D-66.

## Built
- `src/shared/repo.ts` — the `RepoGrant` schema (`{ path, branches: "run/*" }`), `branchMatches` / `branchAllowed` with `main` and `master` refused under every pattern, `validBranchName` so a name can never be an option or a traversal, `narrowerBranches` for the intersection, and the result types the tools return.
- `Permissions.repos` (`src/shared/permissions.ts`) — a fourth grant kind. It composes like the others in `security/permissions.ts`: a repository survives the intersection only if both layers cover it, with the narrower root and the narrower pattern; a ceiling that says nothing about repositories narrows nothing (`ANY_REPO`).
- `ctx.repo` on `ToolContext` (`src/shared/tool.ts`) — `grants()` and `open(path?)`, answering with a `RepoAccess` handle that is policy-checked on every call. Implemented in `src/runtime/repos/access.ts`; the path rules are `src/runtime/security/repoPolicy.ts` (SEC-33); git is spawned directly in `src/runtime/repos/git.ts`; the gate is `src/runtime/repos/gate.ts` (SEC-35).
- `src/runtime/tools/builtin/repo.ts` — `repo.read`, `repo.list`, `repo.write`, `git.status`, `git.diff`, `git.log`, `git.branch`, `git.commit`, `git.push`, `check`. Always in the catalogue, granted to nobody. Each is one call on the handle; nothing in the file opens a file or spawns a process.
- The deny-list as built: every path under `.git/`, refused by what it is (configuration, hooks, the object store, refs, HEAD); any basename the new `CREDENTIAL_FILE_PATTERNS` in `security/secretScan.ts` match (`credentials.json`, `.env` and variants but not `.env.example`, private and ssh keys, `.netrc`, registry auth files, `secrets.*`, service accounts); `.workbench/` for writing; and the workspace's own hard deny-list when a grant happens to cover the workspace. A credentials-shaped file already in the tree is unstaged before a commit and named in `skipped`.
- The branch rule: `repo.write`, `git.commit` and `git.push` work only while the checkout is on a branch the pattern covers; the refusal says "create a run branch first". A push from the wrong branch is refused by name before git is spawned (SEC-34).
- `check` reads `.workbench/repo.json` (`{ check, timeoutMs? }`, strict), runs the line through the platform shell with `2>&1`, `CI=true`, no colour and `childEnv()`, and returns `{ ok, exitCode, durationMs, output, truncated, fullOutput?, command, killedBy }` — the *end* of a long transcript, the whole of it in `scratch/check-<ts>.log`.
- `repo-decided` trace event (`src/shared/events.ts`): the grant's answer on every path and branch name, beside `permission-decided`.
- `GET /tools` gains `grants` (per agent: paths and repositories); the Tools screen gains **What they may reach on disk**; `workbench doctor` gains `repositories` (path exists, is a checkout, has a gate, which branches). The `check` tool is `runsOnHost`, so it is available without Deno and is not in the sandbox's disabled list.
- `examples/workspace/agents/mechanic/` — granted nothing by default; its instructions are the read → branch → edit → check → commit → push loop and what it does not do.
- `.workbench/repo.json` in this repository: `npm run check`, 25 minutes. The Mechanic can now be granted this checkout.
- The plugin loader parses a tool's `maxPermissions` through the schema, so a key added after a plugin was written is defaulted rather than `undefined` at the intersection (found by SEC-27).

## Not built (deliberate)
- The coding workflow, the handoff document and pull-request creation — RUN-17.
- Any tool that takes a command string. `check` takes a repository and nothing else.
- Editing a repository grant from the Tools screen or the CLI. A person writes it in `config/workbench.json`, which is the brief's intent: the grant is the owner saying so.
- `git.merge`, `git.rebase`, `git.reset`, `--force`, `--delete`: they do not exist, so they cannot be granted (SEC-34 asserts the catalogue and the push schema).
- Detecting a repository's default branch beyond `main` and `master`. A pattern that names `develop` names it on purpose.

## Deviations from the brief
- **`ctx.repo` joins the tool context** rather than each tool receiving a host through its deps. The brief says "through the broker"; a handle beside `fs` and `net` is what the spec's `ToolContext` already means by that, and it keeps the ten tools to one line each. Amended into `tools-and-security.md`.
- **`repo.write` is refused on a branch the pattern does not cover.** The amendment said writes are "refused by name outside the grant's branch pattern and root"; the built reading is the checkout's *current* branch, which makes the order of operations — branch first — enforced rather than advised, and keeps an agent off the owner's own `main` checkout.
- **`.workbench/` is unwritable** though the brief's deny-list does not name it: without that, `repo.write` on `repo.json` followed by `check` is a shell by another name, and SEC-35 would be true at the tool boundary only.
- **`check` runs through the platform shell.** The brief says "on the host with `childEnv()`"; the line is `npm run check`, which on Windows is a `.cmd` only a shell can start, and `&&` in an owner's line should mean what it means. It is the one shell in the runtime, and it is safe for exactly one reason: no tool can write the file the line comes from. `runCommand` gained a documented `shell` option for this caller alone.
- **The run id is in trailers, not a prefix.** `Workbench-Run:` and `Workbench-Agent:` under the message, so `git log --oneline` stays readable and every commit still carries the run.
- **`check` is available without Deno.** SEC-23's test asserted every execute-tier tool is unavailable without a sandbox; `check` is the documented exception (D-66) and the test now says so by name.

## Verification transcript
```
npm run check                          typecheck · lint · unit 62 · security 143 · contract 51 · route-drift 73 routes · secret-scan clean
npm run dod -- 16                      6 passed (DoD 1–5; two cases for DoD 4), then the @run-16 e2e case
npx vitest run --project dod           104 passed | 2 skipped (15 suites; the two skips are live-only)
npm run e2e                            33 passed
```
DoD 1: the Mechanic branches, lists (no `.git`), reads, writes; `permission-decided` and `repo-decided` for each; the Weaver, with every tool granted and no repository, is refused with "no repository grant" and the hint naming the config key. DoD 2: `.git/config`, `.git/hooks/pre-commit`, `../outside.txt`, `credentials.json`, `.workbench/repo.json`, and an ordinary file on `main` — six refusals, each naming its rule, nothing on disk changed. DoD 3: `run/16-test` created; `main` ("a person merges into") and `feature/x` ("outside the branches this grant allows") refused; the commit's author is `mechanic <mechanic@workbench.noreply>` with the run id in a trailer; the push reaches the bare remote; from `main` the push is refused and the remote has no `main`. DoD 4: the gate fails with its output, passes after the scripted fix, a repository without `.workbench/repo.json` yields `ToolUnavailable` by name, a planted `WORKBENCH_CRED_*` in the runtime's environment is not seen by the gate's child; a 4 000-line transcript comes back from its end with the whole in scratch. DoD 5: `doctor` lists the repository, `may push to run/*` and its gate, and fails on a path that does not exist. DoD 6: the Tools screen shows the grant, the pattern and "none" for an agent without one.

## SEC tests added
- **SEC-33, SEC-34, SEC-35** → `tests/security/sec-33-35-repos.test.ts`, 12 cases: every git internal in both modes; three spellings of outside; a symlink out; eight credential names and one template; the gate file readable and not writable; a grant covering the workspace still refuses its config; the intersection keeps the narrower root and pattern and drops what neither layer covers; the pattern, the two protected names, the names that cannot be options; a push, a write and a commit from `main` with a recording git — `symbolic-ref` is the only thing spawned; the catalogue has no merge and the push schema no flag; the check schema has no command; a missing or unknown-key gate is refused; the gate's child sees the allowlist and no planted credential.
- SEC-07, SEC-09 and SEC-11 re-verified through the new tools (DoD 1, 2, 4); SEC-23 amended to name `check` as the host-run exception.

## Spec amendments made
- `spec/tools-and-security.md` — RUN-16 amendment: `ctx.repo`, the branch rule, the deny-list exactly, `check` through the shell and its transcript, trailers, `repo-decided`, the trust model in one sentence.
- `spec/api-and-cli.md` — `GET /tools` `grants`, `doctor` repositories, `repo-decided` in the trace list.
- `spec/data-model.md` — the `repo-decided` payload.
- `spec/ui.md` — the Tools screen row.

## Known gaps
- `check` runs whatever `package.json` says, and the agent can edit `package.json`. That is D-66's stated trust model — the boundary is the branch and the person who reads it — not a hole in SEC-35, but it should be said out loud here: a repository grant is trust in the repository's own tooling.
- `git.push` over HTTPS relies on the owner's credential helper; with none configured the push fails with git's words rather than hanging (`GIT_TERMINAL_PROMPT=0`). A `github` tool with a token of its own is RUN-17's "separate decision".
- The e2e case reads the grant table only; a browser case that runs the Mechanic against a fixture repository would need git in the e2e workspace's PATH and is covered by the DoD suite instead.

## Notes for the next run
- RUN-17's workflow needs nothing new from the tools: `git.branch` → `repo.write` → `check` → `git.commit` → `git.push` is the loop, all on `mechanic`. The workflow's `permissions` block can narrow the pattern (`run/13-*`) and the deny for `spec/runs/` is a `repos`-independent path rule that does not exist yet — the simplest form is a second deny segment in `repoPolicy.ts` driven by a grant field, which RUN-17 should add rather than a workflow-only hack.
- A `check` result's `output` is the tail. The scripted fixture in RUN-17's DoD should make the gate print its verdict last, as real gates do.
- `repo-decided` events are the place to read a refused write; the `tool-completed` error carries the same words for the model.
- `tests/dod/RUN-16.test.ts` has `fixtureRepo()` and `script()` — a checkout with a bare remote and a gate that fails until one file is fixed, and a scripted multi-turn conversation keyed per agent and tag. RUN-17 can import both.

## Human verification script
1. `npm run build && node dist/cli.js init ~/wb-16 && node dist/cli.js start --workspace ~/wb-16`.
2. In `~/wb-16/config/workbench.json`, grant the Mechanic this checkout: `"grants": { "mechanic": { "tools": { "repo.read": "allow", "repo.list": "allow", "repo.write": "allow", "git.status": "allow", "git.diff": "allow", "git.log": "allow", "git.branch": "allow", "git.commit": "allow", "git.push": "allow", "check": "allow" }, "repos": [{ "path": "/abs/path/to/ai-workbench", "branches": "run/*" }] } }`. Restart, or grant the tools from the Tools screen and add only `repos` by hand.
3. Open **Tools → What they may reach on disk**. Expect the Mechanic's row to show the path and *may push to run/*; expect `echo` to say *none*. `node dist/cli.js doctor --workspace ~/wb-16` should list the repository with its gate.
4. Run the Mechanic with a real model: "Change one line of a comment in `src/runtime/paths.ts` and push it." Watch the trace: `git.branch` to a `run/…` name, `repo.read`, `repo.write`, `check` (this takes a few minutes — it is `npm run check`), `git.commit`, `git.push`. Expect the branch on GitHub with the Mechanic as author and `Workbench-Run:` in the message.
5. Now ask it to push to `main`. Expect the refusal, by name, in the trace and in the tool's result: "a person merges into". Ask it to write `.git/config`; expect the same shape of no.
6. The one that matters: open the pushed branch on GitHub and read the diff before you merge it. That is the boundary.
