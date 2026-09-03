# RUN-07 handoff — Network tools with containment, and the research briefing

**Branch:** `run/07-web` · **Head:** `ed12b07` · **Status:** awaiting verification

## Built
- `src/runtime/security/dns.ts` — resolution the checker owns. `resolveAndPin` asks the resolver once, checks *every* answer, and returns the single address the socket will use. One blocked answer blocks the request: a name that resolves to a public address and a private one is not half-safe.
- `src/runtime/security/netfetch.ts` — `guardedFetch`, the only way out for a tool. Mode and allowlist decide before any DNS query; the pinned address is dialled through an `undici` connector with a fixed `lookup`, so the address the checker approved is the address the socket gets and the TLS `servername` is still the hostname; redirects are re-checked from the top (up to five) and `https → http` is refused outright; the runtime's own port is refused even under `allowLocalAddresses`.
- `src/runtime/engine/taint.ts` — `RunTaint`: `private_tainted` on `runs`, the `seenUrls` set, and inheritance into delegated children. Reading private content taints (`artifact.read`, `fs.read`, `memory.search`, `knowledge.search`); fetched web content does not.
- The exfiltration rule (D-29) inside `guardedFetch`: a tainted run's non-GET to a non-exempt host, or its GET to an invented URL in `unrestricted` mode, parks in `waiting_approval` before a socket opens. No human available is a refusal, not a wait.
- `src/runtime/search/index.ts` — `brave`, `searxng` and `mock` providers over the same `ctx.net.fetch`, so a configured provider is a *declared* endpoint and its key never becomes a model-chosen destination.
- `src/runtime/tools/builtin/web.ts` — `http.fetch` (GET only, byte-capped, Readability + Turndown to article text with the links it carried) and `web.search`. Links are collected before Readability mutates the document, which is why the tool returns any at all.
- `examples/workspace/agents/{planner,researcher,synthesizer,reviewer}/` and `workflows/research-briefing.workflow.json` — the flagship: a topic becomes questions, a `map` researches them in parallel across two model ids, a synthesizer files the briefing, a reviewer reads it as its reader would. `schedule` seeds a daily row.
- Tools screen: **Where they may go** — the effective network policy per agent, computed by the same code the fetch path uses (`ToolExecutor.netPolicyFor`), plus the workspace mode, allowlist, exempt hosts and search provider.

## Not built (deliberate)
- Non-GET requests from tools. The exfiltration rule handles them because a plugin will eventually make one; no built-in does.
- Filesystem tools outside the project, shell, code, MCP — the brief's *Do not*.
- Memory and knowledge tools taint a run by name in `PRIVATE_TOOLS`, but they do not exist yet (RUN-08).

## Deviations from the brief
- **The synthesizer's document path is `{{inputs.topic}}.md`**, not the brief's `briefings/{{inputs.topic}}.md`. A document path is relative to the run's project, which is already `briefings`; the brief's path filed everything under `briefings/briefings/`. Amended.
- **The mock search fixture moved to `fixtures/search/results.json`.** `fixtures/*.json` is the model mock's namespace, and `search.json` parsed as a model fixture with an empty `match` — which matches every call. The model fixture schema is strict about unknown keys now, so the next stray file is a load-time error instead of a silent catch-all. Amended.
- **A network tool's `maxPermissions` names no `net.mode`.** `NET_ONLY` capped the mode at `allowlist`, which put `unrestricted` out of reach of the only two tools that can use it — and with it the "may follow a link it was shown" half of D-29. Amended.
- **`match.afterTool` was added to the mock adapter.** `callIndex` counts every call a *run* makes, so two researchers running in parallel interleave and neither can be scripted by it. `afterTool` matches on what the conversation has already called, which is per-step by construction.

## Verification transcript
```
$ npm run check
typecheck · lint · unit · security · contract · secret-scan — green
$ npm run dod -- 07
3 passed, 1 skipped (DoD 2 is live-only: WB_LIVE=1 plus a search key)
$ npx vitest run --project dod
every suite, 00 through 12 — green
$ npm run e2e
green, axe clean on every screen
```

## SEC tests added
`tests/security/sec-17-19-egress.test.ts`, 20 cases:
- **SEC-17** a private address as a literal host, before any DNS query; through a DNS answer for a harmless-looking name; when only one of several answers is private; through a redirect, re-checked from the top; `https → http` refused; the approved address is the dialled address (the resolver is asked exactly once); the runtime's own port refused even with `allowLocalAddresses`.
- **SEC-18** the effective mode is the minimum over every layer; an allowlist entry matches a host and its subdomains and nothing that merely starts with it (`example.gov.evil.com` is refused); `offline` reaches nothing; a host outside the allowlist is refused before DNS; the blocked address classes.
- **SEC-19** a tainted run's POST to a non-exempt host parks; to an exempt host it does not; an untainted run is never asked; in `unrestricted` mode a tainted run may follow a URL it was shown but not one it invented; a parked request nobody can approve does not go and opens no socket; a human refusing it is recorded as a refusal; a human allowing it lets exactly that request through. Plus the end-to-end case the brief asks for: a run that read a project document then reaches for an invented URL parks in `waiting_approval` with nothing resolved and nothing dialled.
- **SEC-20** re-verified for tool egress in `tests/security/sec-20-tool-egress-headers.test.ts`: the Brave key reaches the wire as `x-subscription-token` and appears in no event, no `egress_log` row, no `tool_calls` row, no trace and no log — while the egress itself is still on the record.

## Bugs found by the tests
- **A `map`'s `over` implied no dependency.** `over: "steps.plan.output.questions"` created no edge, so the map started at the same moment as `plan` and failed with `"steps.plan" is not available here`. The validator now takes implied edges from `when` and `over` as well as from templates — which was the first thing the flagship workflow did when it ran.
- **A tool ceiling pinned the network mode**, making `unrestricted` unreachable (above).
- **A stray JSON file in `fixtures/` matched every model call** (above).
- **The injected connector was nested inside undici's connect *options***, which produced `Invalid IP address: undefined` rather than a pinned socket. It is built with `buildConnector` and passed as `Agent({ connect })`.
- **"No human available" was in the hint, not the reason**, so the parked-and-refused case read like a policy denial.

## Spec amendments made
- `spec/workflows-and-execution.md` — implied edges come from `when` and a map's `over`, not only from templates
- `spec/tools-and-security.md` — the search fixture path and the strict fixture namespace; a net tool's ceiling names no mode
- `spec/runs/RUN-07.md` — the synthesizer's document path

## For the next run (RUN-08: memory and knowledge)
- `PRIVATE_TOOLS` in `engine/taint.ts` already names `memory.search` and `knowledge.search`. Adding those tools is enough to taint a run that uses them; nothing else needs wiring.
- `RunTaint.observe()` is where URLs enter `seenUrls`. A memory item that carries a URL should go through it, or an agent will be asked about a link its own memory gave it.
- `http.fetch` returns `{ title, text, links, status, finalUrl, bytes, truncated }`. The `links` array is what a crawl-one-level-deeper feature would use, and `seenUrls` already contains them, so following one will not park.

## Still outstanding for the owner
- **No cloud adapter has yet spoken to its provider.** `npm run contract -- --live google` verifies the adapters against the real APIs; `WB_LIVE=1 npm run dod -- 07` runs the briefing on real models and a real search key (`WORKBENCH_CRED_BRAVE`, `WORKBENCH_CRED_GOOGLE`). Everything above is verified against a local socket that believes it is `allowed.test`.
- The human verification for this run: set `search.provider` and the `brave` credential, run the briefing on a topic you care about, read it in the Library, and open the Privacy Inspector to see every host it touched.
