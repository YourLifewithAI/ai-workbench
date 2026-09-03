# RUN-11 — Import/export, plugins, credentials UI, docs, packaging

**Goal.** The project is shareable and installable by someone who is not the author, without any of the author's private data.

**Reads.** `tools-and-security.md` (plugins, imports), `data-model.md` (exports), `api-and-cli.md`, `vision.md`, `runlog/RUN-10.md`.

**Scope.**
- Import/export for agents, workflows, memory, runs, and workspace with `schemaVersion` checks and redaction manifests; import trust stripping (D-34).
- Plugin loader for `<workspace>/plugins/` (adapter, tool, evaluator) with manifest display and the "this code runs with full access" warning; pinned versions; postinstall refused (D-32).
- Settings: credentials editor that writes the 0600 file and never displays values; network mode; budgets; retention; MCP servers.
- `deploy.md` gains the Caddy alternative for owners without Tailscale; systemd/launchd notes for bare-metal installs.
- Docs from `spec/`: README with the ten-minute path, getting started, security, provider development via the contract suite, agent and workflow authoring; `CONTRIBUTING.md` (adapter on-ramp = pass the contract suite).

**Do not.** Build a marketplace, an OS keychain backend, Tauri packaging, or cloud sync.

**Definition of done** (`npm run dod -- 11`).
1. Fresh clone → `npm install` → `npm run build` → `workbench init /tmp/ws` → `workbench start --workspace /tmp/ws --provider mock` → run `story-pipeline` from the UI (e2e drives it).
2. Export an agent, import it into a second workspace: its permissions arrive as requested, not granted; a file with `schemaVersion: 99` is refused with a message.
3. A plugin providing a tool loads, its declared capabilities appear in Tools, the warning was shown once.
4. The Docker image (from RUN-00) passes item 1 of RUN-04.
5. `npm run check` and `npm run e2e` green.

**SEC.** 25, 26, 27.

**Human verification.** Hand the repository to someone else (or a fresh machine) and have them reach a running story pipeline in ten minutes using only the README; then have them complete the five core tasks in `ui.md` (configure, run, read a trace, approve, rate) from the Welcome path without help — every stumble becomes a fix; confirm nothing of yours came along.
