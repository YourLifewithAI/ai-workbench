# Security

AI Workbench runs on your machine, holds your provider keys, and executes model-directed actions. Its security model is in `spec/tools-and-security.md`; the tests that enforce it are `tests/security/`.

**Reporting a vulnerability.** Email the address in `SUPPORT.md` with "security" in the subject. Do not open a public issue. You will get an acknowledgement within a few days and a fix or a mitigation before disclosure.

**In scope.** Bypassing the localhost authentication, escaping a permission policy or the sandbox, exfiltrating private data through tools, leaking credentials into traces or exports, and any way an agent can alter its own permissions.

**Out of scope.** Behavior of third-party model providers, MCP servers, or plugins you chose to install; anything reachable only after you pass `--expose` without TLS.
