# RUN-06 handoff — Tool runtime core, permissions, approvals, safe tools, delegate

**Branch:** `run/06-tools` · **Head:** `3a7a0a3` · **Status:** awaiting verification

## Built
- `src/shared/tool.ts` — `ToolDefinition`, `ToolContext`, `ToolResult`, the error codes a model can act on, and `toolSpec()` with deterministic key ordering so the same tool set produces the same bytes every call (D-46).
- `src/runtime/security/broker.ts` — the only door. Paths are canonicalised with `realpath`, resolving as far as the path exists so a write to a file that is not there yet is still checked. A candidate whose real path leaves a granted root is denied though its lexical path is inside; the hard deny-list is checked on the canonical path; `write` refuses a symlink destination. `can()` gives the decision with no I/O, for a tool whose storage is the database.
- `src/runtime/security/permissions.ts` — composition with no code path that widens. Paths intersect to the narrower root, a `deny` in any layer wins, either layer may demand an approval and neither can waive the other's, and the network mode is the minimum over every layer.
- `src/runtime/tools/executor.ts` — decide, maybe park, execute, record. Parallel calls run concurrently; output is validated against the tool's own schema before the model sees it; D-47's truncation and masking live here.
- `src/runtime/approvals/store.ts` + migration `0007` — the security queue, batched per step, with a timeout that denies. `tool_calls` records every decision, which is what the Tools screen's refusal history reads.
- `src/runtime/tools/builtin/` — `calc` (its own arithmetic parser, no `eval`), `datetime`, `json`, `artifact.read` / `.list` / `.write`, `agent.delegate`, `permission.request`.
- `src/runtime/engine/run.ts` — the approval gate, delegation (parent, depth, carved budget, brief-only input), and the grant plumbing.
- Routes: `GET /approvals`, `POST /approvals/:id`, `GET /tools`, `PUT /tools/grants`; `approvals` on the Dashboard.
- CLI: `workbench approvals list|allow|deny`, `workbench tools list|grants|grant`.
- `src/ui/screens/Tools.tsx` — the catalogue, the grant matrix, remembered rules, and the refusal history. `src/ui/components/ApprovalCard.tsx` — the risk line in plain words, the policy that fired, three buttons with the narrowest remember first, `a`/`d`/`j`/`k` on the Dashboard.
- `examples/workspace/agents/delegator/` and the grants the shipped example needs to run as shipped.

## Not built (deliberate)
- Any network, filesystem-outside-project, shell, code, or MCP tool — the brief's *Do not*. `ctx.net.fetch` refuses with `ToolUnavailable` rather than pretending; the exfiltration rule it needs arrives with RUN-07.
- Memory tools: RUN-08.
- The `execute` tier has no members. It cannot have any until the sandbox exists (D-30, RUN-09), and shipping one without it would be the exact mistake this run's ordering avoids.

## Deviations from the brief
- **`ctx.fs.can(path, mode)` was added to the tool context.** A document lives in the database, so `artifact.write` was asking the broker's permission by *attempting a filesystem write* — which both double-wrote and asked the wrong question. Amended into `tools-and-security.md`.
- **`permission.request` has no `approvalByDefault`.** With it, the human saw a generic "this tool always asks" card and then the real one. Its execute *is* the request. Amended.
- **A delegated run bypasses the run queue.** With the default `maxConcurrentRuns: 2`, a parent holding a slot and waiting for a child deadlocked every chain at depth 2. Amended.
- **A `kind: 'tool'` workflow step runs under `grants.<workflowId>`.** A tool step has no agent, and inventing a wider door for workflow authors than agents get would undo the point of the matrix. Amended.
- **`.` and `/` mean the workspace root** in permission paths. Without it, intersecting a narrow grant with a workspace-wide one produced nothing rather than the narrow one.

## Verification transcript
```
$ npm run check
typecheck · lint · 52 unit · 58 security · 47 contract · secret-scan: clean — green
$ npm run dod -- 06
14 passed, then 2 e2e cases tagged @run-06 passed
$ npm run dod -- 00 … 05
all passed, all tagged e2e passed
$ npm run e2e
21 passed, axe clean on every screen
```

## SEC tests added
`tests/security/sec-09-13-broker.test.ts`, 23 cases:
- **SEC-09** a tool nobody granted is denied however harmless; the agent asking in its own file is not a grant; an explicit `deny` beats a grant in any other layer.
- **SEC-10** a path survives only if both layers cover it, from either direction; disjoint roots intersect to nothing; a sibling whose *name* is a prefix (`projects/anthology-private/` vs `projects/anthology/`) is not covered; the mode is the minimum; an allowlist entry must be in every layer; either layer may demand an approval; a run override cannot widen.
- **SEC-11** every hard-deny directory under a workspace-wide grant; an agent's own `agent.json` through a grant whose root *lexically contains* `agents/`; the runtime token and credentials by name; a symlink whose real path leaves a granted root; a write through a symlink at the destination (with the original file checked afterwards); anything outside the workspace; and the run's own scratch allowed with no grant at all.
- **SEC-12** and **SEC-13** are in the DoD suite, where they need a whole runtime: the timeout that denies and the single narrow rule "remember" writes; the child run's parent, depth, carved budget, and brief-only input, with depth 4 refused by name.

## Bugs found by the tests
- **The symlink check was theatre.** `Broker.write` lstat-ed the path *after* `realpath` had followed the link, so it could never see one. Now checked on the path as given, with a test that writes through a real symlink and asserts the original file is untouched.
- **`permission.request` asked twice**, and the first card had less information than the second.
- **Delegation deadlocked** against `maxConcurrentRuns`.
- **`/` and `.` were not the workspace root**, so a workspace-wide grant intersected to nothing.
- **A batched card listed its actions in row order**, not the order the model asked in.

## Spec amendments made
- `spec/tools-and-security.md` — `ctx.fs.can`, workspace-relative roots, the symlink rule, `permission.request`, when "remember" is offered, ask-order batching, the delegation queue bypass, and the grant a tool step runs under
- `spec/api-and-cli.md` — the approvals, tools and grants routes, the Dashboard's `approvals`, the two CLI groups, and the trace summary leading with the denial

## For the next run (RUN-07: web, research briefing)
- `ctx.net.fetch` is the seam the fetch and search tools plug into; it currently rejects with `ToolUnavailable`. The egress checker it should call already exists from RUN-02 (`security/egress.ts`) — what RUN-07 adds is DNS resolution with address pinning, redirect re-checking, and the exfiltration rule (SEC-17…19).
- `private_tainted` is a column on `runs` that nothing sets yet. The exfiltration rule is what sets it.
- `net.approvalExempt` composes already and is unused: it is the list the exfiltration rule consults before parking a non-GET.
- The approval machinery is ready for it: `ApprovalStore.open` takes any policy string and any `RememberRule`, and a host-shaped remember (`{ tool, host }`) is already what `rememberFor` produces from a `url` argument.

## Still outstanding for the owner
No cloud adapter has yet spoken to its provider. `npm run contract -- --live google` verifies the adapters against the real APIs; `WB_LIVE=1 npm run dod -- 04` runs the story pipeline on Gemini. Both need a credential in the workspace or the environment.

## Human verification script
1. `npm run build && node dist/cli.js init ~/wb-06 && node dist/cli.js start --workspace ~/wb-06`.
2. Open **Tools**. Expect the catalogue and the grant matrix, with everything denied. Read what each tool says
   it would be able to reach — that sentence is the point of the screen.
3. Run the `delegator` example agent with nothing granted. Expect it to be refused by name, and expect the
   refusal to appear in the tool's refusal history rather than only in the trace.
4. Grant `calc` to one agent. Expect the grant to apply to that agent alone; run a different agent and confirm
   it is still refused.
5. Grant `shell` to an agent and run it. Expect the run to park, an approval card on the Dashboard with the
   risk in plain words and the policy that fired, and three buttons with the narrowest *remember* first.
6. Approve with the narrowest remember. Run it again: expect no second card. Then run it with a *different*
   command and expect a new card — the remembered rule was narrow, as advertised.
7. Deny one, and let another sit. A pending approval that nobody answers must become a denial on its own, not
   wait forever; the run should end refused rather than hang.
8. `node dist/cli.js approvals list --workspace ~/wb-06` and `tools grants`. Same facts, terminal side.
9. The one that matters most: try to widen a grant from inside. Edit an agent's own `agent.json` to ask for
   `fs.write` at `/`, and run it. What an agent asks for in its own file is a request; the matrix is the
   authority. Expect the effective permission to be the intersection, and expect the trace to say so.
