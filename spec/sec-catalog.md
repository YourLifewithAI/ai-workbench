# SEC catalog

Every run reads this file for the ids its brief lists (D-38). Each entry is a test in `tests/security/`; the run shown is the first that must pass it, and it stays in the suite forever. A later run that touches the same surface re-verifies the test through the new path.

| ID | Test | Run |
|---|---|---|
| SEC-01 | Request without token → 401 (`health` exempt) | 00 |
| SEC-02 | Wrong `Origin` → 403 | 00 |
| SEC-03 | Wrong `Host` → 403 | 00 |
| SEC-04 | Listener bound to 127.0.0.1 only | 00 |
| SEC-05 | Token file mode 0600; the token appears nowhere except the one URL line `start` prints: not in any HTTP response body, not in `data/logs/` | 00 |
| SEC-06 | A registered secret (planted via credentials and via `--input`) never appears in events, the log file, `trace --json`, or (from 03) exports | 00 |
| SEC-07 | `childEnv()` returns only the allowlist (`PATH HOME TMPDIR LANG LC_* TZ`) with no credential values (unit, 00); a real spawned child sees none (09); `process.env` outside bootstrap and the credentials loader fails lint (00) | 00 |
| SEC-08 | Offline mode blocks cloud egress before a socket opens | 02 |
| SEC-09 | Tools default to deny | 06 |
| SEC-10 | Effective permission is the intersection; run overrides cannot widen | 06 |
| SEC-11 | An agent cannot write its own definition, config, credentials, or `data/` under any grant | 06 |
| SEC-12 | Approval timeout denies; "remember" writes the narrowest rule | 06 |
| SEC-13 | `agent.delegate` cannot escalate permissions, budget, or depth | 06 |
| SEC-14 | Untrusted content never enters an instruction section and does not alter a scripted agent | 08 |
| SEC-15 | A memory write during external-content consumption is listed in Review as untrusted | 08 |
| SEC-16 | Memory scopes are isolated across agents and projects | 08 |
| SEC-17 | Loopback, RFC1918, link-local, CGNAT, and metadata addresses denied directly, via DNS answer, and via redirect; address pinned across resolve and connect; runtime port denied | 07 |
| SEC-18 | Network modes enforced as a lattice; `unrestricted` still blocks private ranges; allowlist matching is label-bounded | 07 |
| SEC-19 | Exfiltration rule: in `unrestricted` mode a tainted run's GET to an invented URL parks (end to end); a tainted run's non-GET to a non-exempt host parks (broker unit test in 07, end to end in 09); the request is not sent | 07 |
| SEC-20 | Egress bodies stored redacted; sensitive headers never stored (model-call path in 01; egress log in 02; tool egress in 07) | 01 |
| SEC-21 | `..`, symlink-out, and symlink creation denied; case rule per platform | 09 |
| SEC-22 | Sandboxed code sees no credentials; denied connects fail; writes outside roots fail; runaway is killed | 09 |
| SEC-23 | No in-process execution when Deno is missing | 09 |
| SEC-24 | MCP servers: scrubbed env, write-tier approval by default | 09 |
| SEC-25 | Imported permissions arrive as requested, not granted; `schemaVersion` mismatch refused | 11 |
| SEC-26 | Exports contain no credential material and carry a redaction manifest | 03 |
| SEC-27 | Plugins load only from `workspace/plugins/`, pinned, with the warning shown | 11 |
| SEC-28a | Run budget caps stop spending (model calls, cost, wall clock) | 04 |
| SEC-28b | The daily cap refuses and stops scheduled runs | 05 |
| SEC-28c | An experiment stops at its budget | 10 |
| SEC-29 | Cancel aborts the in-flight HTTP request | 04 |
| SEC-30 | CSP is strict on HTML and API responses; `dist/` loads nothing from another origin — no `<script src>`, `<link href>`, `fetch`, `XMLHttpRequest`, `EventSource`, `WebSocket`, or `import()` to a non-self origin (XML namespaces and documentation URL strings are not loads) | 00 |
| SEC-31 | Secret scan in the check gate catches a planted key | 00 |
| SEC-32 | Push notification payloads carry ids and kinds only, never prompt, output, or document content | 12 |
| SEC-33 | A repository grant never covers `.git/` internals (`config`, `hooks`, `objects`, `refs`), any credentials-shaped file, or a path that resolves outside the granted root — each refused by name (D-66) | 16 |
| SEC-34 | `git.push` to a branch outside the grant's pattern is refused, `main` first among them; no merge tool exists; a coding agent cannot move `main` (D-66) | 16 |
| SEC-35 | `check` runs only the command declared in the repository's `.workbench/repo.json`; an agent-supplied command is not an input; the child gets `childEnv()` and no credential (D-66) | 16 |
| SEC-36 | A provider's model listing is a proposal and untrusted text: refresh writes nothing; accepting writes only the id, numbers and any stated price, never the display name or description; that text reaches no compiled prompt and renders as text; findings pass through the redactor like any body (D-64) | 15 |
| SEC-37 | The auditor cannot read what it audits the access to: its grant is the two metadata tools, whose `maxPermissions` admit no path, host or credential, and a run of `permissions-review` makes no artifact, memory, knowledge, file, repository or web call. No run can write the grant matrix: no tool sets a grant, the finding routes sit behind the token and the origin check, and a review run leaves `config/workbench.json` and `grant_log` untouched (D-63) | 14 |

> Amendment (RUN-19, 2026-09-04): SEC-05 and SEC-07 are written in POSIX terms, and Windows CI showed both
> asserting the platform rather than the promise.
>
> **SEC-05** is "readable only by this account", not "mode 0600". Windows has no mode bits: `chmod` there
> toggles the read-only attribute, `stat` reports 0666 for any writable file, and 0600 can never be observed.
> The protection there is the ACL — `icacls /inheritance:r /grant:r <you>:F` — and the check is reading it
> back. SYSTEM, Administrators and TrustedInstaller do not count as foreign readers: they sit on nearly every
> file by inheritance, an administrator can take ownership of anything whatever the ACL says, and 0600 on
> Linux does not exclude root either. The three secret files — `data/runtime.token`, `data/vapid.json`,
> `config/credentials.json` — go through one writer that makes this promise, rather than three copies of
> `writeFileSync({ mode })` of which only one had been taught about Windows.
>
> **SEC-07**'s allowlist is per-platform because the variables are: `HOME` and `TMPDIR` do not exist on
> Windows, and a child there cannot start without `SystemRoot`. The refusals are not per-platform and are the
> actual content of the row — no credential value, no arbitrary environment variable, no `NODE_OPTIONS`,
> which is executable by another name.

> Amendment (RUN-13, 2026-09-05): the RUN-13 brief cites SEC-08 for "only a human writes a definition the
> runtime will execute". In this catalog that promise is **SEC-11** — the hard deny list covers `workflows/`
> under any grant — and SEC-08 is offline mode. The editor's write routes add nothing a tool can reach: they
> sit behind SEC-01 and SEC-02 like every other route, and a draft that carries a credential leaves the runtime
> redacted (SEC-06) while the file on disk holds what the owner typed. `tests/security/sec-11-workflow-editor.test.ts`.


> Amendment (RUN-14, 2026-09-05): the RUN-14 brief cites SEC-08 for "only a human writes to the matrix"; as
> with RUN-13, that promise is SEC-11 here, and the new row is SEC-37. `tests/security/sec-37-permissions-review.test.ts`.

> Amendment (F3, 2026-09-05): SEC-28 gains a third case, **SEC-28c**: the monthly cap refuses a run before its
> first call and pauses every schedule until the month turns or the cap is raised; a paused schedule keeps its
> time rather than being counted as missed. `tests/security/sec-28c-monthly-cap.test.ts`.
