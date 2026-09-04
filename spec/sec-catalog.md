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
