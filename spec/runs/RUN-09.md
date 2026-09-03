# RUN-09 — Sandbox, filesystem, code execution, MCP, and the website workflow

**Goal.** The dangerous capabilities ship inside real containment in the same run, with a website-building workflow as proof. Slices: (a) sandbox + filesystem + code, which also owns the shared files (broker registry, Tools screen); (b) MCP client, which adds its own modules and a Tools-screen section only.

**Reads.** `tools-and-security.md` (sandbox, paths, MCP, plugins), `agent-runtime-contract.md`, `ui.md` (Tools), `runlog/RUN-08.md`.

**Scope.**
- Deno sandbox runner (D-30): flags generated from the effective policy, scrubbed environment, scratch cwd, CPU/wall/memory/output limits, kill on overrun; `workbench doctor` reports Deno presence and disabled tools.
- `fs.read`, `fs.list` outside the project with canonicalization (D-27) and the deny-list; `fs.write` outside the project and `code.execute` (JS/TS) inside the Deno sandbox only (no `--allow-net`, no `--allow-run`), with the stdio tool bridge (D-55): the agent's granted tools are exposed as `async` functions inside the sandbox and every call goes back through the broker; `shell` as a limited direct child process, `approvalRequired` by default; `http.request` (non-GET) through the broker with approval by default.
- MCP stdio client (D-31): per-workspace server config, scrubbed env, manifest classification, write-tier approval by default, tools listed in the matrix; `@modelcontextprotocol/server-filesystem` pinned as a devDependency for the example and tests.
- CI: a job with Deno installed runs the sandbox tests; a Deno-absent job keeps SEC-23 honest.
- `examples/workspace/agents/builder/` and `workflows/build-site.workflow.json`: Architect → Builder writes `projects/<slug>/files/site/` → a sandboxed check step (lint/build) → Reviewer; site opens as a folder or zip (D-43).
- Tools screen: sandbox status, MCP servers, per-server tools.

**Do not.** Execute anything outside the sandbox when Deno is missing. Add Python. Serve user HTML from the runtime origin. Add plugins.

**Definition of done** (`npm run dod -- 09`).
1. `build-site` on mock writes files under the project and the check step runs inside Deno with the generated flags (asserted from the spawn arguments).
2. With Deno absent (simulated), `doctor` lists the disabled tools and steps calling `code.execute` or out-of-project `fs.write` fail with `ToolUnavailable`; no in-process execution path exists (lint bans `node:vm`; a grep test asserts no `eval`).
3. The reference MCP filesystem server connects; its read tools run with a grant; its write tool parks in `waiting_approval`.
4. A `code.execute` script that calls two bridged tools completes in one model turn; a bridged call to an ungranted tool returns `PermissionDenied` inside the sandbox and appears in the trace like any other denial.

**SEC.** 21 (`..`, a symlink inside an allowed root pointing outside, symlink creation; the case rule on each CI platform), 22 (sandboxed code reads `Deno.env` and sees no credential; a direct connect fails because no `--allow-net` exists; a bridged fetch to a denied host is refused by the broker; a write outside roots fails; an infinite loop is killed), 23, 24, 07 (a real spawned child sees no credential), 19 (non-GET branch end to end via `http.request`), 11 re-verified through `fs.write` and through an MCP write tool.

**Human verification.** Run the site workflow, open the folder, view the site in your browser from disk; try to make the Builder write to `~/.ssh` in its instructions and watch it be denied with the policy named.
