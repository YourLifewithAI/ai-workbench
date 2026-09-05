# RUN-16 — Repository tools

**Goal.** An agent can work on a git repository the owner has granted it — read the tree, edit files, run the repository's own check command, and commit to a branch — with the same door and the same refusals as every other tool, and with no path by which anything it does reaches `main` without a person.

**Reads.** `tools-and-security.md` (§Tools, §Grants, the RUN-16 amendment), `architecture.md` (config, `grants`), `sec-catalog.md` SEC-09 · 11 · 33 · 34 · 35, D-25, D-26, D-30, D-33, D-66, `runlog/RUN-06.md` (the broker), `runlog/RUN-09.md` (`shell` and `childEnv`).

**Why now.** The owner wants the workbench built from inside the workbench (D-67). Today every tool an agent has is aimed at documents, memory and the web; a coding agent needs a repository, git, and a gate, and it needs them without a human approving every write. `shell` is the wrong shape for that: it is approval-per-call by design, it takes any command, and a grant to it is a grant to everything. What a coding agent needs is narrower than `shell` and wider than `fs.write` — and a way to say "this repository, these branches, this gate" that a person writes once.

**Scope.**
- **The `repos` grant.** `Permissions` gains `repos: [{ path, branches }]`, absolute path and a branch glob (default `run/*`). It composes like every other grant (D-26): an agent's own file may *request* one; only `config/workbench.json` grants it; the intersection rule applies. The Tools screen shows it beside the path grants with the branch pattern it allows.
- **`repo.read` / `repo.list` / `repo.write`** through the broker, resolving under the granted root with the existing canonicalisation, case rule, and Windows name rules. The hard deny-list extends to `.git/` internals — `config`, `hooks`, `objects`, `refs`, `HEAD` — and to any file whose name matches the credentials patterns the secret scanner knows (SEC-33). Reported paths are repository-relative with forward slashes, as `fs.list` already reports them.
- **`git.status` / `git.diff` / `git.log`** (read), **`git.branch` / `git.commit` / `git.push`** (write). Implemented by spawning `git` directly — never through a shell — with `childEnv()` and the repository as cwd. `git.branch` creates or switches only to a branch matching the grant's pattern; `git.push` pushes only the current branch, only if it matches the pattern, and refuses by name otherwise, `main` included (SEC-34). There is **no** `git.merge`, `git.rebase`, `git.reset --hard`, or `git.push --force`: none of them exist as tools, so none can be granted. Commit author is the agent's id under the workbench's noreply address; the message is the agent's, prefixed with the run id.
- **`check`.** Runs the command declared in `<repo>/.workbench/repo.json` — `{ "check": "npm run check", "timeoutMs": 900000 }` — on the host with `childEnv()`, captures stdout and stderr, and returns `{ ok, exitCode, durationMs, output }` with output truncated per D-47 and stored whole in the trace. The agent supplies no command and no arguments (SEC-35). A repository with no `repo.json` has no `check`, and the tool says so by name. Execute-tier; exists only under a `repos` grant, not under the sandbox.
- `workbench doctor` reports each granted repository: path exists, is a git checkout, has a `repo.json`, and which branches the grant allows.
- A shipped example: `examples/workspace/agents/mechanic/` — an agent granted nothing by default whose instructions describe the read → edit → check → commit loop, so the Tools screen has something to grant a repository to.

**Do not.**
- Do not build the coding workflow, the runlog handoff, or PR creation — that is RUN-17.
- Do not add a `shell`-shaped escape: no tool in this run takes a command string from the agent.
- Do not let `check` run inside the Deno sandbox, and do not let anything else in this run run outside it.
- Do not let a repository grant imply a path grant or the reverse; they are different kinds and compose separately.
- Do not touch `main`, ever, from any tool: not push, not branch, not checkout.

**Definition of done** (`npm run dod -- 16`).
1. An agent with a `repos` grant on a fixture repository reads a file, lists a directory, writes a file, and the trace shows each decision; the same calls with no grant are refused by name.
2. `repo.write` to `.git/config`, to `.git/hooks/pre-commit`, to a path resolving outside the root, and to a file named `credentials.json` are each refused, and the refusal names the rule (SEC-33).
3. `git.branch` to `run/16-test` succeeds; `git.branch` to `main` and to `feature/x` are refused. `git.commit` records the agent as author with the run id in the message. `git.push` to the run branch reaches a bare fixture remote; `git.push` from `main` is refused before any network call (SEC-34).
4. `check` runs the declared command and returns `ok: false` with the failing output for a fixture whose gate fails, then `ok: true` after the fixture is fixed; a repository with no `repo.json` yields `ToolUnavailable` by name; the child's environment carries no `WORKBENCH_CRED_*` (SEC-35).
5. `doctor` lists the granted repository with its branch pattern and whether it has a gate.
6. e2e: the Tools screen shows the repository grant and its branch pattern.

**SEC.** 33, 34, 35 (new), 09 and 11 re-verified through the new tools, 07 for `check`'s child.

**Human verification.** Grant the `mechanic` agent this repository with `run/*`, ask it to change one line of a comment, and watch it read, edit, `check`, commit and push to a run branch — then ask it to push to `main` and read the refusal.
