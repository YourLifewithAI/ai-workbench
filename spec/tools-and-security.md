# Tools and security

*Prose cap: 1800 words. Decisions cited: D-21, D-25 … D-34, D-38, D-43, D-44. The SEC test catalog is `sec-catalog.md`.*

## Threat model

1. Content the agent reads is hostile: a web page, a tool result, or a stored memory instructs it to read private data and send it somewhere.
2. Anything on the machine or in the browser is hostile to the API that spends the owner's keys: other processes, other tabs, DNS rebinding.
3. A tool, MCP server, or plugin is compromised and runs with whatever authority it was given.
4. Secrets end up at rest where they were never meant to be: traces, logs, exports.
5. An agent that can write files rewrites its own permissions or another agent's instructions.

The permission layer stays authoritative when the model is manipulated. That is the whole design goal.

## Security floor — Run 00, never deferred (D-21, D-33)

- The runtime binds `127.0.0.1` unless `WORKBENCH_BIND` says otherwise, and says so loudly on start.
- A bearer token is generated per start, written to `data/runtime.token` (0600), and printed once as a URL fragment (`http://127.0.0.1:8787/#token=…`). The SPA reads the fragment, keeps the token in memory only, and sends `Authorization: Bearer <token>` on every request including SSE (fetch-based, not `EventSource`). Every `/api` route except `health` returns 401 without it.
- `Host` must be one of `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` (or the `--bind` address); `Origin`, when present, must be `http://` + one of those; `Origin: null` is 403. No CORS wildcard; no cookies. The SPA uses history routing, the runtime serves `index.html` for non-API paths, and the SPA strips `#token=` from the URL after reading it.
- CSP: `default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'` — no third-party origins, no analytics, ever.
- Credentials: `config/credentials.json` (0600), shape `{ "<name>": { "apiKey": "…" } }`, or process env `WORKBENCH_CRED_<NAME>`. The loader is the only module allowed to read them; adapters and tools receive scoped values through their context. Every child process (sandbox, MCP server) gets an explicitly constructed environment.
- Redaction: every loaded credential value is registered; persisted events, logs, and exports pass through the redactor. Headers named `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-subscription-token`, and any `x-goog-*` are never stored. A secret scan runs in `npm run check`.
- The runtime is never exposed to the public internet (D-60). Remote access is over a Tailscale tailnet: `--expose <tailnet-hostname>` adds that origin to the accepted `Host`/`Origin` sets and `tailscale serve` provides TLS; a Caddy reverse proxy on a private network is the documented alternative for owners without Tailscale. The bearer token is required either way.

> Amendment (RUN-19, 2026-09-04): "0600" above names the POSIX implementation of a promise that is not
> POSIX-specific. The promise is *readable only by the account that owns this workspace*, and it covers three
> files: `data/runtime.token`, `config/credentials.json` and `data/vapid.json`. On Linux and macOS it is mode
> 0600. Windows has no mode bits — `chmod` there toggles the read-only attribute and `stat` reports 0666 for
> anything writable — so it is a file ACL, applied on write with `icacls /inheritance:r /grant:r <you>:F` and
> read back to check. All three go through one writer (`security/secretFile.ts`) rather than each repeating
> the mode, and `workbench doctor` reports any of them it cannot confirm.

## Tools (D-25)

```ts
interface ToolDefinition<I, O> {
  id: string; version: string; description: string;
  input: ZodType<I>; output: ZodType<O>;
  tier: 'read' | 'write' | 'execute';
  maxPermissions: Permissions;              // the most this tool can ever be granted
  credentials?: string[];                   // credential names it may receive, e.g. ['brave']
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
interface ToolContext {
  runId: string; stepId: string; agentId: string; scratchDir: string;
  fs: { read(p): Promise<Buffer>; list(p): Promise<Entry[]>; write(p, data): Promise<void> };   // policy-checked
  net: { fetch(url: string, init?: FetchInit): Promise<Response> };                             // policy-checked
  credentials: { get(name: string): string | undefined };                                       // only declared names
  log(message: string): void;
}
```

The model sees a `ToolSpec` (name, description, JSON Schema) derived from the definition at the provider boundary. Tool outputs are structured (D-51): the model receives the validated object, `http.fetch` keeps extracted text and links apart, and the engine fences every result as content. Model-side injection defenses do not close data leakage on their own (`research.md`), which is why the broker and the exfiltration rule exist. Built-ins by tier: **read** — `calc`, `datetime`, `json`, `artifact.read` (which also reads the run's own scratch directory as `scratch/…` without a grant, so masked and truncated results are always recoverable), `artifact.list`, `knowledge.search`, `memory.search`, `http.fetch`, `web.search`; **write** — `artifact.write`, `memory.remember`, `fs.read`, `fs.list` (outside the project), `http.request` (non-GET; `approvalRequired` by default), `agent.delegate`, `permission.request`; **execute** — `fs.write` outside project files, `shell`, `code.execute`. Execute-tier tools exist only when the sandbox does (D-30).

**`http.fetch`** — in `{ url, maxBytes?, accept? }`; out `{ status, finalUrl, contentType, title?, text, links: [{ text, url }], truncated, bytes }`. `http:` and `https:` only. HTML is parsed without script execution (`linkedom` + `@mozilla/readability` + `turndown`); JSON and text pass through; PDF goes through `pdf-parse`; anything else is `UnsupportedContentType`. Limits: `tools.http.maxResponseBytes` (default 2 MiB, truncate and flag) and `tools.http.timeoutMs` (default 20 000), separate from `toolCallTimeoutMs`.

**`web.search`** (D-44) — in `{ query, count?: 1..20 = 8, freshness?: 'day' | 'week' | 'month' | 'any' }`; out `{ results: [{ title, url, snippet, published? }] }`. Provider from `config/workbench.json` → `"search": { "provider": "brave" | "searxng" | "mock", "searxng": { "url": "…" } }`; the Brave key is credential `brave`. `--provider mock` mocks every external service, search included; the search mock reads `<workspace>/fixtures/search.json`: `{ "queries": [{ "match": "<substring>", "results": [{ title, url, snippet }] }] }`, falling back to an empty result list.

> Amendment (RUN-07, 2026-09-03): the mock search fixture is `<workspace>/fixtures/search/results.json`, one
> directory down. `fixtures/*.json` is the model mock's own namespace, and a file there that is not a model
> fixture parsed as one with an empty `match` — which matches every call. The model fixture schema is strict about
> unknown keys now, so a stray file is a load-time error rather than a silent catch-all.

> Amendment (RUN-07, 2026-09-03): a network tool's `maxPermissions` names no `net.mode`. The ceiling says the tool
> may use the network and nothing else; the mode belongs to the workspace, the agent, the workflow and the run. A
> ceiling of `allowlist` on `http.fetch` and `web.search` put `unrestricted` out of reach of the only two tools
> that can use it, and with it the "may follow a link it was shown" half of the exfiltration rule.

## Permissions and the broker (D-26, D-27)

```jsonc
"permissions": {
  "fs":  { "read": ["projects/briefings/"], "write": ["projects/briefings/files/"] },
  "net": { "mode": "allowlist", "allow": ["*.gov", "reuters.com"], "allowLocalAddresses": false,
           "approvalExempt": [] },
  "tools": { "http.fetch": "allow", "artifact.write": "allow", "shell": "deny" },
  "approvalRequired": ["http.request", "fs.write"]
}
```

Effective permission for a call = tool `maxPermissions` ∩ agent grant (workspace-stored, not the file's request) ∩ workflow ceiling ∩ run overrides. The hard deny-list wins over every grant: `<workspace>/config/`, `agents/`, `workflows/`, `plugins/`, `data/`, `runtime.token`, the runtime's own installation, any `.git/`.

All tool I/O goes through `src/runtime/security/broker`. Tools receive `ctx.fs` and `ctx.net`, which check policy on every call; they never import `node:fs` or call `fetch`. Paths: policy roots and candidates are both canonicalized with `realpath` and the platform case rule (case-insensitive compare on macOS and Windows, case-sensitive on Linux); a candidate whose real path is outside the root is denied even if its lexical path is inside; symlink creation is refused by `fs.write`.

An ungranted tool of any tier is denied (SEC-09). An approval is required, whatever the tier, when the tool is in `approvalRequired`, when the agent calls `permission.request`, when an MCP write-tier tool has no explicit grant, or when the exfiltration rule below fires.

## Egress (D-28, D-29)

One checker serves adapters and tools. Modes form a lattice `offline < local-only < allowlist < unrestricted`; the effective mode is the minimum over workspace config, agent grant, workflow ceiling, and run overrides. `allowLocalAddresses` applies to `allowlist` and `unrestricted` and is true only if every layer says so. Allowlist entries are hostnames: `example.com` matches the host and its subdomains (label-bounded); `*.example.com` matches subdomains only; comparison is case-insensitive on punycode with trailing dots stripped; an optional `:port` restricts the port; with several layers, a host must match each layer's list.

Blocked address classes (checked for every resolved address; one blocked answer blocks the request): IPv4 `0.0.0.0/8, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 224.0.0.0/4, 255.255.255.255`; IPv6 `::, ::1, fc00::/7, fe80::/10` and IPv4-mapped forms; names `localhost`, `metadata`, `metadata.google.internal`. Numeric hosts are parsed canonically (no decimal, octal, or shortened forms). The broker resolves with `dns.lookup({ all: true })`, checks every address, pins one, and connects to it with the hostname as SNI through an `undici` `Agent` whose `lookup` and `connect` are injectable (tests resolve `*.test` names to TEST-NET-3 addresses and dial a local server). Redirects: at most 5, `301 302 303 307 308`, each target re-checked against the allowlist and the address classes, `https → http` refused, headers stripped across hosts. Any request to the runtime's bound address or to loopback on the runtime's port is denied in every mode.

> Amendment (RUN-02, 2026-09-03): an **enabled catalog entry is itself the declaration** for a model call, whether or
> not it names a `baseUrl` — enabling a model in `config/models.json` is the act by which the owner allows that
> destination. Model calls are therefore declared endpoints: subject to the mode, not to tool allowlists. The
> mode is still what refuses a cloud call in `offline` or `local-only`.
>
> Amendment (RUN-02, 2026-09-03): RUN-02 ships the mode lattice, declared endpoints, blocked address classes for
> literal hosts, and the egress log. DNS resolution with address pinning, redirect re-checking, and the
> exfiltration rule arrive with RUN-07's tool egress (SEC-17, SEC-18, SEC-19); until then a hostname that
> resolves to a private address is caught only when the host is written as a literal.

**Declared endpoints** — the `baseUrl` of a catalog model, the configured search provider, and configured MCP commands — are harness endpoints the owner wrote into config. They are subject to the workspace mode and are logged, but not to agent allowlists, and a declared loopback address (Ollama, SearXNG) is allowed by declaration. A model-generated destination never receives this status.

Every egress is logged: destination, resolved address, purpose (`model | tool | search | mcp`), data categories (`instructions | task | memory | document | tool-output | url`), bytes, decision, and a redacted body. This feeds the Privacy Inspector.

**Exfiltration rule (D-29).** Mode and allowlist are evaluated first: a destination the effective mode does not allow is denied outright and never parks. The rule below applies only to requests the mode would allow. A run is *private-tainted* once its prompt included memory or knowledge sections, or a tool returned private content (`artifact.read`, `fs.read`, `memory.search`, `knowledge.search`); fetched web content does not taint; children inherit taint. The run also keeps `seenUrls`: every URL that appeared in a step input or a tool result. A tool-initiated request is parked in `waiting_approval` when the run is private-tainted and either (a) the method is not GET and the host is not in `net.approvalExempt` or a remembered approval, or (b) the mode is `unrestricted`, the method is GET, the host is not in `net.allow`, and the URL is not in `seenUrls`. So a scheduled briefing in `allowlist` mode runs unattended, an agent in `unrestricted` mode may follow links it was shown, and an invented URL or any body carrying private data waits for a human. Harness endpoints are exempt.

## Approvals

An approval item records the tool, arguments, the policy that triggered it, and the run's recent context; the run parks in `waiting_approval` (`approval-requested`). Timeout (default 30 minutes) resolves to deny. The decision returns to the agent as a `ToolResult`; an approved request is then sent. "Remember" writes exactly `{ tool, path | host }` to workspace config. Approvals queue on the Dashboard and in `workbench approvals`.

## Sandbox (D-30)

`code.execute` and `fs.write` outside the project run in a Deno subprocess launched by the broker with flags generated from the effective policy (`--allow-read=<roots> --allow-write=<roots>`; **never** `--allow-net` or `--allow-run`), an explicitly constructed environment with no credentials, cwd in the run's scratch directory, and CPU time, wall clock, memory, and output-size limits. Network from inside the sandbox exists only through the tool bridge (D-55): granted tools are exposed as functions whose calls travel over the child's stdio as JSON-RPC back to the broker, so DNS pinning, the egress log, and the exfiltration rule apply unchanged. `shell` runs a command as a direct child process with the same scrubbed environment, scratch cwd, and limits; because a subprocess's network cannot be policed portably, `shell` is `approvalRequired` by default and the approval card says so — a container sandbox is the unlock (`vision.md`). Deno absent → `code.execute` and out-of-project `fs.write` are reported unavailable by `workbench doctor` and calls fail with `ToolUnavailable`. There is no in-process fallback and Node `vm` is banned by lint (D-30).

> Amendment (RUN-09, 2026-09-03): the bridge is stdout and stdin, not a separate fd. A call is one line on stdout
> prefixed with a per-run nonce; the reply comes back on stdin. The nonce is not a secret kept from the script —
> it reads its own preamble — it is there so an ordinary `console.log` of a JSON object is printing rather than
> calling. Forging a call gains a script nothing: it can only name tools the broker would decide on anyway.

> Amendment (RUN-09, 2026-09-03): a script may name **any** tool, and the broker answers. An ungranted name comes
> back as `PermissionDenied` in the words a model would get, recorded in the trace the same way, rather than as a
> function that is not defined — "you may not" and "there is no such thing" are different answers, and only one
> of them is true. The exception is the execute tier itself, which is refused from inside: a sandbox does not
> start a sandbox.

> Amendment (RUN-09, 2026-09-03): the generated flags name `--deny-net`, `--deny-run` and `--deny-ffi` explicitly
> as well as omitting the allow flags. Omission already denies; naming them means a future Deno that widens a
> default cannot widen this sandbox silently.

> Amendment (RUN-09, 2026-09-03): a **ceiling narrows only what it mentions**. A workflow whose `permissions`
> block lists `tools` and no paths has said nothing about paths, and its steps keep the filesystem grants their
> agents already have. Reading that silence as "no paths" stripped every grant from the first shipped workflow
> that had a `permissions` block. The grant layer is unaffected: an agent with no `fs.write` still has none,
> because that layer is an answer rather than a ceiling.

## MCP (D-31) and plugins (D-32)

MCP servers are configured per workspace (command, args, env allowlist), spawned with a scrubbed environment, and classified by manifest: tools without a read-only annotation are write-tier and require approval by default. Their tools appear in the Tools screen next to built-ins with the same grant model.

Plugins in `<workspace>/plugins/<name>/` are trusted code with the runtime's authority. Each has `plugin.json` — `{ schemaVersion: 1, name, version, kind: 'adapter' | 'tool' | 'evaluator', entry: '<file>.js', capabilities: string[] }` — shown before first load with the words "this code runs with full access"; the entry module default-exports the matching interface (`ModelAdapter`, `ToolDefinition`, or an evaluator); versions are pinned; postinstall scripts are refused.

> Amendment (RUN-11, 2026-09-03): the acknowledgement is per plugin **and version**, stored in
> `config/workbench.json` as `plugins.trusted: ["name@version"]`. A new version is new code and asks again. The
> loader also refuses, before importing anything of the plugin's: a version that is a range rather than a pin, a
> directory whose name does not match the manifest, an entry that resolves outside the plugin directory (a
> symlink included), a `package.json` whose version disagrees with the manifest, and any `preinstall`,
> `install`, `postinstall` or `prepare` script — those run before a person can read the code.

> Amendment (RUN-11, 2026-09-03): a plugin's tools are namespaced `<plugin>.<tool>`, so a grant is per plugin and
> per tool. Loading is not granting: a plugin's tools arrive in the matrix granted to nobody.

## Imports, exports, served content

Import trust is defined in `agents-and-prompts.md` (D-34) and exports in `data-model.md` (D-35). User HTML is never served from the runtime origin (D-43).

> Amendment (RUN-06, 2026-09-03): what the tool runtime settled.
>
> - **`ctx.fs.can(path, mode)`** joins the context: the decision alone, with no I/O. A tool whose storage is not the filesystem — the Library keeps documents in the database — still has to ask, and asking by attempting a write would be worse than asking directly.
> - **Permission paths are workspace-relative**, and `.` and `/` both mean the workspace root. Anything resolving outside the workspace is refused whatever a grant says.
> - **The symlink check is on the path as given.** `realpath` has already followed the link by the time a decision is made, so an `lstat` on the resolved path would always say "not a link" and the check would be theatre.
> - **`permission.request` has no `approvalByDefault`.** Its execute *is* the approval request, and the card it raises names what was asked and why. A generic gate in front of it asks the human the same question twice, with less information the first time. The card's policy line says which rule fired; the risk line carries the what and the why from the args.
> - **"Remember" is offered only when there is a narrow rule to write.** For `artifact.write` that is `{ tool, path: "<directory>" }` — the directory, not the project and not the tool. For `permission.request` what was asked is prose, so no rule is offered rather than a meaningless one.
> - **A batched card lists its actions in ask order** (ascending ULID), not in whatever order the rows came back.
> - **A delegated run bypasses the run queue.** The parent holds a slot and waits for the child, so queueing a delegation behind `execution.maxConcurrentRuns` deadlocks a chain at depth 2.
> - **A `kind: 'tool'` workflow step runs under a grant named for the workflow** — `grants.<workflowId>` — rather than inventing a wider door than an agent gets. The workspace needs an agent definition with the workflow's id to hold that grant; otherwise the step is refused with a message saying so.

> Amendment (RUN-12, 2026-09-03): an approval row carries an `ordinal` — where the call sat in the response that asked for it — so a batched card lists its actions in ask order. ULIDs were tried first and are wrong for this: they are only monotonic within a millisecond when a monotonic factory makes them, and two parallel tool calls land in the same millisecond.

> Amendment (RUN-16 plan, 2026-09-05): D-66 adds a fourth grant kind, `repos`, and the tools it unlocks.
> By tier: **read** — `repo.read`, `repo.list`, `git.status`, `git.diff`, `git.log`; **write** — `repo.write`,
> `git.branch`, `git.commit`, `git.push`; **execute** — `check`. `check` is execute-tier but is *not* a sandbox
> tool: it runs the repository's declared gate on the host, because the gate is the owner's own command and
> spawns things a sandbox cannot. It exists only under a repository grant, takes no command from the agent,
> and gets `childEnv()` like any child (SEC-35). `git.push` and `repo.write` are refused by name outside the
> grant's branch pattern and root (SEC-33, SEC-34). The Tools screen lists repository grants beside path grants
> and says which branches each may push to.

> Amendment (RUN-16, 2026-09-05): what the repository tools settled.
>
> - **`ctx.repo` joins the tool context** beside `fs` and `net`: `grants()` and `open(path?)`, where the handle
>   `open` answers with is policy-checked on every call and never exists for a checkout nobody granted. A tool
>   in `tools/builtin/repo.ts` is one call on that handle; the grant decides in `repos/access.ts`, the policy
>   lives in `security/repoPolicy.ts`, and git is spawned in `repos/git.ts` — directly, never through a shell,
>   with every agent-supplied name validated before it is an argument. Paths in and out are repository-relative
>   with forward slashes; `repo` may be omitted when exactly one repository is granted.
> - **Writes, commits and pushes happen only on a branch the grant covers.** `repo.write` on a checkout that
>   is on `main` is refused with "create a run branch first", so an agent cannot dirty the owner's own branch
>   and the order of operations — read, branch, edit, check, commit, push — is enforced rather than advised.
>   `main` and `master` are refused under every pattern, `*` included: the pattern names run branches, not the
>   branch a person merges into.
> - **The deny-list, exactly:** every path under `.git/` (the internals named by what they are: configuration,
>   hooks, the object store, refs, HEAD); any basename the secret scanner's *file-name* patterns match
>   (`credentials.json`, `.env` and variants but not `.env.example`, private keys, ssh keys, `.netrc`,
>   registry auth files, `secrets.*`, service accounts); `.workbench/` for writing, because the gate declaration
>   is the owner's (SEC-35); and, when a grant happens to cover the workspace, the workspace's own hard
>   deny-list (SEC-11). A credentials-shaped file already lying in the tree is unstaged before a commit and
>   named in the result's `skipped`.
> - **`check` runs the declared line through the platform shell**, with `2>&1` so the transcript reads in
>   order, `CI=true` and no colour, `childEnv()` and nothing else. The shell is the one place in the runtime a
>   command line is executed, and it is safe here for exactly one reason: the line comes from a file no tool
>   can write. The result carries the *end* of a long transcript — that is where the verdict is — and the
>   whole of it lands in the run's scratch as `scratch/check-<ts>.log` (D-47). `check` is execute-tier and
>   `runsOnHost`, so it exists without Deno; the sandbox's "what is switched off" list does not include it.
> - **A commit is the agent's, with the run in trailers:** author `<agentId> <<agentId>@workbench.noreply>`,
>   message as given plus `Workbench-Run:` and `Workbench-Agent:` trailers, rather than a prefix on the subject
>   line — `git log --oneline` stays readable and the run id is still in every commit.
> - **Every decision is in the trace** as `repo-decided` `{ tool, repo, path, mode, allowed, reason }`, beside
>   the `permission-decided` the matrix already writes. A machine with no `git` on PATH refuses the git tools
>   by name, and `doctor` says so.
> - The trust model is as D-66 states it and no wider: `check` runs whatever `package.json` says, and the
>   agent can edit `package.json`. What the agent cannot do is name a command, touch `main`, or ship anything
>   a person has not read. The boundary is the branch.

