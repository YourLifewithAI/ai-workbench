# RUN-07 — Network tools with containment, and the research briefing

**Goal.** Agents fetch and search the web without becoming an exfiltration channel, and the flagship workflow — a scheduled, multi-model research briefing — runs live.

**Reads.** `tools-and-security.md` (tools, egress, exfiltration rule, approvals), `workflows-and-execution.md` (`map`, scheduler), `agent-runtime-contract.md`, `api-and-cli.md`, `data-model.md` (egress_log, runs.private_tainted), `runlog/RUN-06.md`.

**Scope.**
- `ctx.net.fetch` through the broker with the full egress checker (D-28): mode lattice, label-bounded allowlists, address classes, broker-side DNS, pinned `undici` connection with injectable `lookup`/`connect`, redirect re-checks, own-port denial, declared endpoints; `egress_log` rows and `egress-denied` events.
- `http.fetch` (GET) and `web.search` per `tools-and-security.md`, with the `search` config block, the `brave` credential, the SearXNG provider, and the mock search provider (fixture file `fixtures/search.json`).
- Exfiltration rule (D-29): `runs.private_tainted`, `seenUrls`, `net.approvalExempt`, wired to approvals. Privacy Inspector shows tool egress rows with data categories and redacted bodies.
- `examples/workspace/agents/{planner,researcher,synthesizer,reviewer}/` and `workflows/research-briefing.workflow.json`: Planner (`outputSchema: { questions: string[] }`) → `map` over `steps.plan.output.questions` into Researcher (`web.search` + `http.fetch`) → Synthesizer (`output.document: "briefings/{{inputs.topic}}.md"`) → Reviewer; at least two distinct model ids; `net.mode: allowlist` in the example grants; a `schedule` block (daily) that seeds the table; review non-blocking.
- Tools screen shows network tools and the effective network policy per agent.

> Amendment (RUN-07, 2026-09-03): the synthesizer's `output.document` is `{{inputs.topic}}.md`, not
> `briefings/{{inputs.topic}}.md`. A document path is relative to the run's project, which is already `briefings`,
> so the brief's path filed everything under `briefings/briefings/`.

**Do not.** Add filesystem tools outside the project, shell, code, MCP, or non-GET requests.

**Definition of done** (`npm run dod -- 07`).
1. The briefing completes on mock: the search fixture returns URLs under `allowed.test`, the injected `lookup` resolves `*.test` to a TEST-NET-3 address and `connect` dials a local HTTP server, and the synthesized document cites the fetched URLs.
2. Live (`WB_LIVE=1`, the search key, and every model key the workflow references present; otherwise skipped with a reason) a real briefing is produced under a `maxCostUsd` of 1.
3. With `allowlist: ["*.gov"]`, a fetch to `example.com` is denied before any DNS query, with a hint naming the policy; the denial appears as `egress-denied` in the trace and as a denied row in the Inspector.
4. A schedule row exists for the briefing after workspace load.

**SEC.** 17 (direct literal, via DNS answer, via redirect; pinned across resolve and connect; own port even with `allowLocalAddresses`), 18 (lattice minimum; label-bounded matching rejects `example.gov.evil.com`), 19 (end to end in `unrestricted` mode: a run that read a project document then fetches an invented URL parks in `waiting_approval` and no socket opens; unit: the broker parks a synthetic POST from a tainted run to a non-exempt host), 20 (re-verified for tool egress: `x-subscription-token` never stored).

**Human verification.** Set `search.provider` and the `brave` credential in `config/`, run the briefing on a topic you care about, read it in the Library, open the Privacy Inspector and see every host it touched and what categories of data went there.
