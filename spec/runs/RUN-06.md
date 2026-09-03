# RUN-06 — Tool runtime core, permissions, approvals, safe tools, delegate

**Goal.** Tools exist, are denied by default, and the human sees every decision. Only tools that cannot hurt anything ship, so the permission machinery is exercised before it guards anything dangerous.

**Reads.** `tools-and-security.md` (tools, permissions and broker, approvals), `agent-runtime-contract.md`, `api-and-cli.md` (tools, approvals routes), `ui.md` (Tools, Review → approvals), `runlog/RUN-05.md`.

**Scope.**
- `ToolDefinition`, `ToolContext`, `ToolResult` in `src/shared/tool.ts`; `ToolSpec` derivation; the broker with `ctx.fs` and `ctx.net` handles (`ctx.net` refuses everything until RUN-07); permission composition (D-26), the hard deny-list, path canonicalization; grants stored in `config/workbench.json` under `grants.<agentId>`, requested vs granted.
- Approvals: `approvals` table, `waiting_approval`, timeout → deny (default 30 min), batched per step; the approval card per `ui.md` (risk line in plain words, the policy that fired, *Allow once* / *Allow and remember for this host or path* / *Deny*, narrowest remember as default, `a`/`d` keys) (D-57); `execution.escalation` setting shown in Settings; `permission.request`; approvals on the Dashboard and Review screen; `workbench approvals`.
- Workflow `kind: 'tool'` steps (the RUN-04 validator refusal is lifted).
- Tools: `calc`, `datetime`, `json`, `artifact.read`, `artifact.list`, `artifact.write` (within the run's project), `agent.delegate` (D-12, brief-only input per D-48), `permission.request`; per-run scratch directory; structured denials; tool events in the trace; the harness section lists tools and permissions; concurrent execution of parallel tool calls, result truncation with `meta.fullResult`, and observation masking per D-47 with `context.*` config.
- `examples/workspace/agents/delegator/` (a planner that delegates to Architect). Tools screen: built-ins, tool × agent grant matrix, denial history; the Agents screen shows granted vs requested permissions.

**Do not.** Add any network, filesystem-outside-project, shell, code, or MCP tool. Add memory tools.

**Definition of done** (`npm run dod -- 06`).
1. A fixture agent calls `calc`; the `tool-requested`, `permission-decided`, and `tool-completed` events carry the call and result.
2. An agent without a grant calls `artifact.write`: it receives `PermissionDenied` with a hint naming the policy; the run continues and completes.
3. `permission.request` creates an approval (`approval-requested`); a fake-clock timeout resolves to deny; approving in the UI lets the retry succeed; "remember" writes exactly one narrow rule to `config/workbench.json`.
4. `delegator` calls `agent.delegate` to Architect: a child run with `parent_run_id`, `depth = 1`, a smaller budget, and permissions ⊆ the parent's appears nested in the trace; depth 4 is refused with `DelegationDepthExceeded`.
5. Two approvals raised by one step appear as one batched card with both actions listed.
6. A fixture that returns a 50 KB `artifact.read` result is truncated in the transcript with a `fullResult` pointer, and after six tool rounds the first result is masked in the compiled prompt while the trace keeps it whole; two tool calls in one response run concurrently (overlapping `tool-requested`/`tool-completed` timestamps).
7. e2e: grant a tool in the matrix, approve a pending item from the Dashboard with the keyboard.

**SEC.** 09, 10, 11 (as a broker policy unit test: a grant whose root lexically contains `agents/` still denies the agent's own `agent.json`; end to end in 09), 12, 13.

**Human verification.** Give Cutter `artifact.write`, withhold it from Weaver, add "also save a one-line note with artifact.write" to Weaver's task, run the pipeline, and see one denial explained in the trace; approve a `permission.request` from the Dashboard and watch the step continue.
